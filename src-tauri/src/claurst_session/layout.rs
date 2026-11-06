//! 中间区域布局：从模型正文里提取 ``layout`` 围栏、校验并过滤。
//!
//! 规则（`docs/design/ai-layout.md`）：
//! - 只有**行首**的三个反引号才是围栏；行内反引号是正文。
//! - 语言标记 `layout` → 布局；`json` 或空 → 兼容候选（闭合后整份校验通过才当布局）；
//!   其它 → 普通代码块，原样显示。
//! - 候选围栏体在闭合前一个字符都不发；一条消息取最后一份合法布局。
//!
//! 两份实现、一份规则：
//! - [`strip`]：纯函数，整段扫描。正文出口、历史写库、请求结束复核都用它。
//! - [`Filter`]：流式状态机，逐 delta 产出可见正文。
//!
//! 两者对任意切分必须等价（`tests::arbitrary_splits_match_strip`）。

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Map, Value};

/// 候选围栏体上限。超过就放弃候选，按普通代码块补发，防止模型吐一个巨大 JSON。
pub const MAX_BODY_BYTES: usize = 64 * 1024;
pub const MAX_BLOCKS: usize = 8;
pub const MAX_TARGETS: usize = 6;
pub const MAX_TARGET_CHARS: usize = 24;

/// AI 能写的块。`issue_card` 是系统叠加层，写进布局会渲染两张故障卡。
pub const BLOCK_TYPES: [&str; 5] = [
    "empty_hint",
    "proxy_card",
    "source_choice",
    "reachability",
    "update_hint",
];

/// 非法布局的原因码。只进日志，不出现在界面。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    BadJson,
    BadVersion,
    UnknownBlock,
    DuplicateBlock,
    BadProps,
    TooManyBlocks,
    UnsafeString,
    /// 块本身合法，但与配置形态不符（例如 TUN 配置里的 `proxy_card`）。
    WrongConfigMode,
}

impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Reason::BadJson => "bad_json",
            Reason::BadVersion => "bad_version",
            Reason::UnknownBlock => "unknown_block",
            Reason::DuplicateBlock => "duplicate_block",
            Reason::BadProps => "bad_props",
            Reason::TooManyBlocks => "too_many_blocks",
            Reason::UnsafeString => "unsafe_string",
            Reason::WrongConfigMode => "wrong_config_mode",
        }
    }
}

/// 整段解析 + 校验。返回规范化后的布局（`targets` 已 trim、去重）。
pub fn parse_and_validate(text: &str) -> Result<Value, Reason> {
    let value: Value = serde_json::from_str(text).map_err(|_| Reason::BadJson)?;
    validate(&value)
}

/// 按配置形态校验：`proxy_card` 只在系统代理配置下有意义——TUN 配置没有监听端口。
pub fn validate_for(connect_mode: &str, value: &Value) -> Result<Value, Reason> {
    let layout = validate(value)?;
    if connect_mode != crate::store::configs::CONNECTION_SYSTEM_PROXY {
        let has_proxy_card = layout["blocks"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "proxy_card"));
        if has_proxy_card {
            return Err(Reason::WrongConfigMode);
        }
    }
    Ok(layout)
}

/// 完整校验：结构、块白名单、props schema、字符串安全。非法整份拒绝。
pub fn validate(value: &Value) -> Result<Value, Reason> {
    let object = value.as_object().ok_or(Reason::BadJson)?;
    if object.len() != 2 || !object.contains_key("version") || !object.contains_key("blocks") {
        return Err(Reason::BadJson);
    }
    match object.get("version") {
        Some(Value::Number(number)) if number.as_u64() == Some(1) => {}
        _ => return Err(Reason::BadVersion),
    }
    let blocks = object
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or(Reason::BadJson)?;
    if blocks.len() > MAX_BLOCKS {
        return Err(Reason::TooManyBlocks);
    }

    let mut seen: Vec<&str> = Vec::new();
    let mut canonical = Vec::with_capacity(blocks.len());
    for block in blocks {
        let block = block.as_object().ok_or(Reason::BadJson)?;
        if block.keys().any(|key| key != "type" && key != "props") {
            return Err(Reason::BadProps);
        }
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .ok_or(Reason::BadJson)?;
        if !BLOCK_TYPES.contains(&block_type) {
            return Err(Reason::UnknownBlock);
        }
        if seen.contains(&block_type) {
            return Err(Reason::DuplicateBlock);
        }
        seen.push(block_type);

        let mut out = Map::new();
        out.insert("type".into(), Value::String(block_type.to_string()));
        if let Some(props) = normalize_props(block_type, block.get("props"))? {
            out.insert("props".into(), props);
        }
        canonical.push(Value::Object(out));
    }

    Ok(json!({ "version": 1, "blocks": canonical }))
}

fn normalize_props(block_type: &str, props: Option<&Value>) -> Result<Option<Value>, Reason> {
    if block_type != "reachability" {
        return match props {
            None => Ok(None),
            Some(Value::Object(map)) if map.is_empty() => Ok(None),
            Some(_) => Err(Reason::BadProps),
        };
    }

    let map = props.and_then(Value::as_object).ok_or(Reason::BadProps)?;
    if map.len() != 1 {
        return Err(Reason::BadProps);
    }
    let targets = map
        .get("targets")
        .and_then(Value::as_array)
        .ok_or(Reason::BadProps)?;
    if targets.is_empty() || targets.len() > MAX_TARGETS {
        return Err(Reason::BadProps);
    }

    let mut normalized: Vec<String> = Vec::new();
    for target in targets {
        let text = target.as_str().ok_or(Reason::BadProps)?;
        let text = text.trim();
        let length = text.chars().count();
        if length == 0 || length > MAX_TARGET_CHARS {
            return Err(Reason::BadProps);
        }
        if unsafe_target(text) {
            return Err(Reason::UnsafeString);
        }
        if !normalized.iter().any(|kept| kept == text) {
            normalized.push(text.to_string());
        }
    }
    if normalized.is_empty() {
        return Err(Reason::BadProps);
    }
    Ok(Some(json!({ "targets": normalized })))
}

/// `targets` 是唯一原样进界面的模型字符串，限制成「一个短名字」。
fn unsafe_target(text: &str) -> bool {
    if text.chars().any(char::is_control) {
        return true;
    }
    if text
        .chars()
        .any(|c| matches!(c, '<' | '>' | '&' | '"' | '\''))
    {
        return true;
    }
    if text.contains("://") || text.contains('/') || text.contains(':') {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    lower.starts_with("javascript:") || lower.starts_with("data:")
}

/// 正文里裸 JSON 的计数（只记行数，不含内容）。用于判断提示词是否收住了。
static BARE_JSON_LINES: AtomicU64 = AtomicU64::new(0);

pub fn bare_json_lines() -> u64 {
    BARE_JSON_LINES.load(Ordering::Relaxed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Layout,
    Compat,
    Ordinary,
}

fn classify(info: &str) -> Kind {
    let info = info.trim();
    if info.eq_ignore_ascii_case("layout") {
        Kind::Layout
    } else if info.is_empty() || info.eq_ignore_ascii_case("json") {
        Kind::Compat
    } else {
        Kind::Ordinary
    }
}

/// 行首围栏起始行：≤3 个空格 + ≥3 个反引号 + 语言标记。返回语言标记。
fn opening_info(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let spaces = line.chars().take_while(|c| *c == ' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = &line[spaces..];
    let ticks = rest.chars().take_while(|c| *c == '`').count();
    if ticks < 3 {
        return None;
    }
    Some(&rest[ticks..])
}

/// 闭合行：整行 trim 后是 3 个及以上反引号，后面没有内容。
fn is_close_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= 3 && trimmed.chars().all(|c| c == '`')
}

/// 整段过滤：返回（可见正文，最后一份合法布局）。
pub fn strip(text: &str) -> (String, Option<Value>) {
    let mut out = String::new();
    let mut layout: Option<Value> = None;
    let mut mode = Mode::Prose;
    let mut candidate: Option<Candidate> = None;
    let mut bare_lines = 0u64;

    for line in text.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        match mode {
            Mode::Prose => match opening_info(content) {
                Some(info) => match classify(info) {
                    Kind::Ordinary => {
                        out.push_str(line);
                        mode = Mode::CodeFence;
                    }
                    kind => {
                        candidate = Some(Candidate::new(kind, line));
                        mode = Mode::Candidate;
                    }
                },
                None => {
                    if content.trim_start().starts_with('{') {
                        bare_lines += 1;
                    }
                    out.push_str(line);
                }
            },
            Mode::CodeFence => {
                out.push_str(line);
                if is_close_line(content) {
                    mode = Mode::Prose;
                }
            }
            Mode::Candidate => {
                let current = candidate.as_mut().expect("候选状态必有候选");
                if is_close_line(content) {
                    let candidate = candidate.take().expect("候选状态必有候选");
                    conclude(candidate, Some(line), &mut out, &mut layout);
                    mode = Mode::Prose;
                } else {
                    current.body.push_str(line);
                    if current.body.len() > MAX_BODY_BYTES {
                        // 太大：放弃候选，补发成普通代码块。
                        let candidate = candidate.take().expect("候选状态必有候选");
                        out.push_str(&candidate.opening);
                        out.push_str(&candidate.body);
                        mode = Mode::CodeFence;
                    }
                }
            }
        }
    }

    if let Some(candidate) = candidate.take() {
        conclude_unclosed(candidate, &mut out, &mut layout);
    }

    if bare_lines > 0 {
        BARE_JSON_LINES.fetch_add(bare_lines, Ordering::Relaxed);
        log::debug!("layout.bare_json lines={bare_lines}");
    }

    (out, layout)
}

/// 闭合的候选：显式 `layout` 一律不显示；兼容候选只有整份通过校验才吞掉。
fn conclude(candidate: Candidate, close_raw: Option<&str>, out: &mut String, layout: &mut Option<Value>) {
    match candidate.kind {
        Kind::Layout => match parse_and_validate(&candidate.body) {
            Ok(value) => record_layout(value, layout),
            Err(reason) => log::warn!("layout.invalid reason={}", reason.code()),
        },
        Kind::Compat => match parse_and_validate(&candidate.body) {
            Ok(value) => record_layout(value, layout),
            Err(_) => {
                out.push_str(&candidate.opening);
                out.push_str(&candidate.body);
                if let Some(close) = close_raw {
                    out.push_str(close);
                }
            }
        },
        // 普通代码块不进入候选状态；真到了这里就原样显示，别丢用户的内容。
        Kind::Ordinary => {
            out.push_str(&candidate.opening);
            out.push_str(&candidate.body);
            if let Some(close) = close_raw {
                out.push_str(close);
            }
        }
    }
}

/// 未闭合的候选：显式 `layout` 永远不显示（合法的照样生效）；兼容候选校验不过就原样显示。
fn conclude_unclosed(
    mut candidate: Candidate,
    out: &mut String,
    layout: &mut Option<Value>,
) {
    // 流式路径下最后一行可能还没换行，闭合判定要在摘掉它之前做。
    let trailing_close = if is_close_line(&candidate.line) {
        let line = std::mem::take(&mut candidate.line);
        let cut = candidate.body.len().saturating_sub(line.len());
        candidate.body.truncate(cut);
        Some(line)
    } else {
        None
    };

    match candidate.kind {
        Kind::Layout => match parse_and_validate(&candidate.body) {
            Ok(value) => record_layout(value, layout),
            Err(reason) => log::warn!("layout.unclosed_invalid reason={}", reason.code()),
        },
        Kind::Compat => match parse_and_validate(&candidate.body) {
            Ok(value) => record_layout(value, layout),
            Err(_) => {
                out.push_str(&candidate.opening);
                out.push_str(&candidate.body);
                if let Some(close) = trailing_close {
                    out.push_str(&close);
                }
            }
        },
        Kind::Ordinary => {
            out.push_str(&candidate.opening);
            out.push_str(&candidate.body);
            if let Some(close) = trailing_close {
                out.push_str(&close);
            }
        }
    }
}

fn record_layout(value: Value, layout: &mut Option<Value>) {
    log::info!(
        "layout.ok blocks={}",
        value["blocks"].as_array().map_or(0, Vec::len)
    );
    *layout = Some(value);
}

struct Candidate {
    kind: Kind,
    /// 起始行原文，含换行（若原文有）。
    opening: String,
    /// 已收到的围栏体（含中间换行）。
    body: String,
    /// 流式：当前未结束的行。整段扫描不用。
    line: String,
}

impl Candidate {
    fn new(kind: Kind, opening: &str) -> Self {
        Self {
            kind,
            opening: opening.to_string(),
            body: String::new(),
            line: String::new(),
        }
    }
}

enum Mode {
    Prose,
    CodeFence,
    Candidate,
}

/// 流式过滤器：逐 delta 喂入，返回本次可以显示的正文（可能为空串）。
pub struct Filter {
    mode: Mode,
    /// 行首缓冲：只保存可能的围栏起始前缀。
    line: String,
    at_line_start: bool,
    candidate: Option<Candidate>,
    layout: Option<Value>,
}

impl Default for Filter {
    fn default() -> Self {
        Self::new()
    }
}

impl Filter {
    pub fn new() -> Self {
        Self {
            mode: Mode::Prose,
            line: String::new(),
            at_line_start: true,
            candidate: None,
            layout: None,
        }
    }

    /// 最后一份合法布局。生产路径以 [`strip`] 的返回值为准，这里供测试与诊断。
    pub fn layout(&self) -> Option<&Value> {
        self.layout.as_ref()
    }

    pub fn push(&mut self, delta: &str) -> String {
        let mut out = String::new();
        for ch in delta.chars() {
            match self.mode {
                Mode::Prose => self.step_prose(ch, &mut out),
                Mode::CodeFence => self.step_fence(ch, &mut out),
                Mode::Candidate => self.step_candidate(ch, &mut out),
            }
        }
        out
    }

    /// 取消时的收尾：未闭合的候选围栏整段丢弃，不补发半截 JSON。
    /// 用户按了停止，消息本来就不完整，突然多出一段 JSON 只会更困惑。
    pub fn finish_discarding(&mut self) -> String {
        if matches!(self.mode, Mode::Candidate) {
            self.candidate = None;
            self.mode = Mode::Prose;
            self.line.clear();
            self.at_line_start = true;
            return String::new();
        }
        self.finish()
    }

    /// 流结束：冲刷持有区、判定未闭合围栏。
    pub fn finish(&mut self) -> String {
        let mut out = String::new();
        match std::mem::replace(&mut self.mode, Mode::Prose) {
            Mode::Prose => {
                if !self.line.is_empty() {
                    let line = std::mem::take(&mut self.line);
                    match opening_info(&line) {
                        Some(info) if classify(info) == Kind::Layout => {
                            // 显式布局围栏没写完：不显示半截 JSON。
                            log::warn!("layout.unclosed_invalid reason=bad_json");
                        }
                        Some(info) => {
                            let kind = classify(info);
                            if kind == Kind::Ordinary {
                                out.push_str(&line);
                            } else {
                                conclude_unclosed(
                                    Candidate::new(kind, &line),
                                    &mut out,
                                    &mut self.layout,
                                );
                            }
                        }
                        None => out.push_str(&line),
                    }
                }
            }
            Mode::CodeFence => {
                // 普通代码块每个字符都已经发出去，这里没有剩余。
            }
            Mode::Candidate => {
                if let Some(candidate) = self.candidate.take() {
                    conclude_unclosed(candidate, &mut out, &mut self.layout);
                }
            }
        }
        self.line.clear();
        self.at_line_start = true;
        out
    }

    fn step_prose(&mut self, ch: char, out: &mut String) {
        if !self.at_line_start {
            out.push(ch);
            if ch == '\n' {
                self.at_line_start = true;
            }
            return;
        }

        if self.line.is_empty() {
            match ch {
                '\n' => out.push('\n'),
                ' ' | '`' => self.line.push(ch),
                _ => {
                    out.push(ch);
                    self.at_line_start = false;
                }
            }
            return;
        }

        let spaces = self.line.chars().take_while(|c| *c == ' ').count();
        let ticks = self.line.chars().filter(|c| *c == '`').count();
        if ticks < 3 && spaces + ticks == self.line.chars().count() {
            // 还只是空格/少量反引号：可能继续长成围栏起始。
            match ch {
                ' ' if ticks == 0 && spaces < 3 => self.line.push(ch),
                '`' => self.line.push(ch),
                '\n' => {
                    let line = std::mem::take(&mut self.line);
                    out.push_str(&line);
                    out.push('\n');
                }
                _ => {
                    let line = std::mem::take(&mut self.line);
                    out.push_str(&line);
                    out.push(ch);
                    self.at_line_start = false;
                }
            }
            return;
        }

        // 已有 ≥3 个反引号：整行是起始行，等到换行才能知道语言标记。
        if ch == '\n' {
            let mut opening = std::mem::take(&mut self.line);
            opening.push('\n');
            match classify(opening_info(&opening).unwrap_or_default()) {
                Kind::Ordinary => {
                    out.push_str(&opening);
                    self.mode = Mode::CodeFence;
                }
                kind => {
                    self.candidate = Some(Candidate::new(kind, &opening));
                    self.mode = Mode::Candidate;
                }
            }
        } else {
            self.line.push(ch);
        }
    }

    fn step_fence(&mut self, ch: char, out: &mut String) {
        out.push(ch);
        if ch == '\n' {
            let line = std::mem::take(&mut self.line);
            if is_close_line(&line) {
                self.mode = Mode::Prose;
                self.at_line_start = true;
            }
        } else {
            self.line.push(ch);
        }
    }

    fn step_candidate(&mut self, ch: char, out: &mut String) {
        let (close, overflow) = {
            let candidate = self.candidate.as_mut().expect("候选状态必有候选");
            candidate.body.push(ch);
            if ch == '\n' {
                let line = std::mem::take(&mut candidate.line);
                if is_close_line(&line) {
                    let cut = candidate.body.len() - (line.len() + 1);
                    candidate.body.truncate(cut);
                    (Some(line), false)
                } else {
                    (None, candidate.body.len() > MAX_BODY_BYTES)
                }
            } else {
                candidate.line.push(ch);
                (None, false)
            }
        };

        if let Some(close_line) = close {
            let candidate = self.candidate.take().expect("候选状态必有候选");
            let mut close_raw = close_line;
            close_raw.push('\n');
            conclude(candidate, Some(&close_raw), out, &mut self.layout);
            self.mode = Mode::Prose;
            self.at_line_start = true;
        } else if overflow {
            // 太大：放弃候选，把已收到的部分当普通代码块补发出去。
            let candidate = self.candidate.take().expect("候选状态必有候选");
            out.push_str(&candidate.opening);
            out.push_str(&candidate.body);
            self.line = candidate.line;
            self.mode = Mode::CodeFence;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip_text(text: &str) -> String {
        strip(text).0
    }

    fn layout_of(text: &str) -> Value {
        strip(text).1.expect("应当提取出布局")
    }

    const SAMPLE: &str = "好的，我把代理卡放到第一位。\n```layout\n{ \"version\": 1, \"blocks\": [ { \"type\": \"proxy_card\" } ] }\n```\n还需要我调整顺序吗？\n";

    #[test]
    fn a_layout_fence_disappears_from_the_text() {
        assert_eq!(
            strip_text(SAMPLE),
            "好的，我把代理卡放到第一位。\n还需要我调整顺序吗？\n"
        );
        assert_eq!(layout_of(SAMPLE)["blocks"][0]["type"], json!("proxy_card"));
    }

    #[test]
    fn json_fences_are_candidates_only_when_the_whole_body_validates() {
        let with_layout = "看这个：\n```json\n{\"version\":1,\"blocks\":[{\"type\":\"empty_hint\"}]}\n```\n好了。\n";
        assert_eq!(strip_text(with_layout), "看这个：\n好了。\n");
        assert_eq!(
            layout_of(with_layout)["blocks"][0]["type"],
            json!("empty_hint")
        );

        let ordinary = "示例：\n```json\n{\"hello\":\"world\"}\n```\n就这样。\n";
        assert_eq!(strip_text(ordinary), ordinary);
        assert!(strip(ordinary).1.is_none());
    }

    #[test]
    fn unmarked_fences_are_candidates_too() {
        let text = "```\n{\"version\":1,\"blocks\":[]}\n```\n";
        assert_eq!(strip_text(text), "");
        assert_eq!(layout_of(text)["blocks"], json!([]));
    }

    #[test]
    fn bare_json_in_prose_is_never_parsed_or_swallowed() {
        let text = "布局长这样：{\"version\":1,\"blocks\":[]}，记住了吗？\n";
        assert_eq!(strip_text(text), text);
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn inline_backticks_are_prose() {
        let text = "像这样：三个反引号 ``` 开头。\n";
        assert_eq!(strip_text(text), text);
    }

    #[test]
    fn a_half_written_fence_stays_visible() {
        assert_eq!(strip_text("没写完：``"), "没写完：``");
        assert_eq!(strip_text("没写完：\n``"), "没写完：\n``");
        let mut filter = Filter::new();
        // 行内反引号不是围栏：立即发出。
        assert_eq!(filter.push("没写完：``"), "没写完：``");
        assert_eq!(filter.finish(), "");
        // 行首两个反引号先持有，流结束时冲刷。
        let mut filter = Filter::new();
        assert_eq!(filter.push("没写完：\n``"), "没写完：\n");
        assert_eq!(filter.finish(), "``");
    }

    #[test]
    fn an_unclosed_layout_fence_never_leaks_json() {
        let valid = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"update_hint\"}]}";
        assert_eq!(strip_text(valid), "");
        assert_eq!(layout_of(valid)["blocks"][0]["type"], json!("update_hint"));

        let invalid = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"nope\"}]}";
        assert_eq!(strip_text(invalid), "");
        assert!(strip(invalid).1.is_none());
    }

    #[test]
    fn an_unclosed_json_code_block_is_shown_as_the_model_typed_it() {
        let text = "```json\n{\"hello\":";
        assert_eq!(strip_text(text), text);
    }

    #[test]
    fn the_last_valid_layout_wins_and_all_fences_disappear() {
        let text = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"empty_hint\"}]}\n```\n中间\n```layout\n{\"version\":1,\"blocks\":[{\"type\":\"proxy_card\"}]}\n```\n";
        assert_eq!(strip_text(text), "中间\n");
        assert_eq!(layout_of(text)["blocks"][0]["type"], json!("proxy_card"));
    }

    #[test]
    fn an_invalid_later_layout_does_not_erase_an_earlier_valid_one() {
        let text = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"empty_hint\"}]}\n```\n```layout\n{\"version\":2}\n```\n";
        assert_eq!(
            layout_of(text)["blocks"][0]["type"],
            json!("empty_hint")
        );
    }

    #[test]
    fn unknown_blocks_and_issue_card_are_rejected_as_a_whole() {
        for body in [
            r#"{"version":1,"blocks":[{"type":"nope"}]}"#,
            r#"{"version":1,"blocks":[{"type":"issue_card"}]}"#,
            r#"{"version":1,"blocks":[{"type":"empty_hint"},{"type":"empty_hint"}]}"#,
            r#"{"version":1,"blocks":[{"type":"proxy_card","style":{}}]}"#,
            r#"{"version":"1","blocks":[]}"#,
            r#"{"version":1,"blocks":[],"extra":1}"#,
        ] {
            let text = format!("```layout\n{body}\n```\n");
            let (visible, layout) = strip(&text);
            assert_eq!(visible, "", "显式 layout 围栏不该显示：{body}");
            assert!(layout.is_none(), "应当整份拒绝：{body}");
        }
    }

    #[test]
    fn empty_blocks_is_legal_and_means_blank() {
        let text = "```layout\n{\"version\":1,\"blocks\":[]}\n```\n";
        assert_eq!(strip_text(text), "");
        assert_eq!(layout_of(text)["blocks"], json!([]));
    }

    /// `proxy_card` 只在系统代理配置下有意义：TUN 配置它指向一个没监听的端口。
    #[test]
    fn proxy_card_is_only_valid_for_proxy_configs() {
        let layout = json!({"version":1,"blocks":[{"type":"proxy_card"}]});
        assert!(validate_for("system_proxy", &layout).is_ok());
        assert_eq!(
            validate_for("tun", &layout),
            Err(Reason::WrongConfigMode)
        );

        let other = json!({"version":1,"blocks":[{"type":"empty_hint"}]});
        assert!(validate_for("tun", &other).is_ok());
    }

    /// 取消时未闭合的候选整段丢弃；正常结束仍然按「模型打出来的样子」补发。
    #[test]
    fn cancelling_discards_unclosed_candidates() {
        let mut filter = Filter::new();
        assert_eq!(filter.push("正在写\n```json\n{\"a\":"), "正在写\n");
        assert_eq!(filter.finish_discarding(), "");

        let mut filter = Filter::new();
        assert_eq!(filter.push("正在写\n```json\n{\"a\":"), "正在写\n");
        assert_eq!(filter.finish(), "```json\n{\"a\":");
    }

    #[test]
    fn block_props_are_restricted() {
        assert!(parse_and_validate(
            r#"{"version":1,"blocks":[{"type":"proxy_card","style":{}}]}"#
        )
        .is_err());
        assert!(parse_and_validate(
            r#"{"version":1,"blocks":[{"type":"empty_hint","props":{"a":1}}]}"#
        )
        .is_err());
        assert!(parse_and_validate(r#"{"version":1,"blocks":[{"type":"reachability"}]}"#).is_err());
        assert!(parse_and_validate(
            r#"{"version":1,"blocks":[{"type":"reachability","props":{"targets":[]}}]}"#
        )
        .is_err());
        assert!(parse_and_validate(
            r#"{"version":1,"blocks":[{"type":"reachability","props":{"targets":["a","b","c","d","e","f","g"]}}]}"#
        )
        .is_err());

        let value = parse_and_validate(
            r#"{"version":1,"blocks":[{"type":"reachability","props":{"targets":[" 视频网站 ","视频网站","新闻"]}}]}"#,
        )
        .unwrap();
        assert_eq!(
            value["blocks"][0]["props"]["targets"],
            json!(["视频网站", "新闻"])
        );
    }

    #[test]
    fn unsafe_targets_are_rejected() {
        for target in [
            "<script>",
            "a&b",
            "javascript:alert(1)",
            "https://example.com",
            "a/b",
            "a:b",
            "a\"b",
            "a'b",
            "a\nb",
            "很长的服务名字超过了二十四个字符的硬性上限所以必须拒绝掉",
        ] {
            let body = json!({
                "version": 1,
                "blocks": [{ "type": "reachability", "props": { "targets": [target] } }]
            });
            assert!(
                parse_and_validate(&body.to_string()).is_err(),
                "应当拒绝 {target:?}"
            );
        }
    }

    #[test]
    fn too_many_blocks_are_rejected() {
        let blocks: Vec<Value> = (0..MAX_BLOCKS + 1)
            .map(|_| json!({"type": "empty_hint"}))
            .collect();
        assert_eq!(
            validate(&json!({"version": 1, "blocks": blocks})),
            Err(Reason::TooManyBlocks)
        );
    }

    #[test]
    fn oversized_candidates_fall_back_to_a_code_block() {
        let body = "x".repeat(MAX_BODY_BYTES + 10);
        let text = format!("```layout\n{body}\n```\n尾\n");
        let out = strip_text(&text);
        assert!(out.contains("```layout"), "太大时按普通代码块显示");
        assert!(out.contains("尾"));
    }

    #[test]
    fn stripping_is_idempotent() {
        let once = strip_text(SAMPLE);
        assert_eq!(strip_text(&once), once);
    }

    #[test]
    fn arbitrary_splits_match_strip() {
        let samples = [
            SAMPLE.to_string(),
            "开头\n```json\n{\"version\":1,\"blocks\":[]}\n```\n结尾\n".to_string(),
            "```js\nlet a = 1;\n```\n正文\n```layout\n{\"version\":1,\"blocks\":[{\"type\":\"reachability\",\"props\":{\"targets\":[\"视频\"]}}]}\n```\n完\n".to_string(),
            "一行里有 ``` 反引号。\n````\n{\"version\":1,\"blocks\":[]}\n````\n".to_string(),
            "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"proxy_card\"}]}".to_string(),
            "结尾两个反引号 ``".to_string(),
            "```json".to_string(),
            "```layout".to_string(),
            "   ```layout\n{\"version\":1,\"blocks\":[]}\n```\n尾".to_string(),
        ];

        for text in samples {
            let (expected_text, expected_layout) = strip(&text);
            let boundaries: Vec<usize> = text
                .char_indices()
                .map(|(index, _)| index)
                .chain(std::iter::once(text.len()))
                .collect();

            // 每一个字节位置切成两段。
            for &boundary in &boundaries {
                let mut filter = Filter::new();
                let mut out = filter.push(&text[..boundary]);
                out.push_str(&filter.push(&text[boundary..]));
                out.push_str(&filter.finish());
                assert_eq!(out, expected_text, "两段切分 {boundary}：{text:?}");
                assert_eq!(filter.layout(), expected_layout.as_ref(), "布局 {boundary}");
            }

            // 逐字符喂入。
            let mut filter = Filter::new();
            let mut out = String::new();
            for ch in text.chars() {
                out.push_str(&filter.push(&ch.to_string()));
            }
            out.push_str(&filter.finish());
            assert_eq!(out, expected_text, "逐字符：{text:?}");
            assert_eq!(filter.layout(), expected_layout.as_ref());

            // 三段切分。
            let third = boundaries[boundaries.len() / 3];
            let two_thirds = boundaries[boundaries.len() * 2 / 3];
            let mut filter = Filter::new();
            let mut out = filter.push(&text[..third]);
            out.push_str(&filter.push(&text[third..two_thirds]));
            out.push_str(&filter.push(&text[two_thirds..]));
            out.push_str(&filter.finish());
            assert_eq!(out, expected_text, "三段切分：{text:?}");
            assert_eq!(filter.layout(), expected_layout.as_ref());
        }
    }
}

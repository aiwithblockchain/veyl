//! 中间区域布局：从模型正文里识别布局并过滤。
//!
//! 规则（`docs/design/ai-layout.md` §2、§3）：
//! - `layout` 围栏是显式声明：**一律不进正文**，能解析且合法才写库。
//! - `json`/无标记围栏与行首裸 JSON 按形状判定：对象同时有 `version` 与 `blocks`
//!   才算「布局形状」；形状是就**永远不进正文**，形状否就按普通内容放行。
//! - 合不合法只在写入时判断，不影响显不显示。
//! - 只有**行首**才是候选：行内反引号、「把 {"version":1} 发给我」里的 `{` 都是正文。
//! - 一条消息取最后一份合法布局。
//!
//! 两份实现、一份规则：
//! - [`strip`]：纯函数，整段扫描。正文出口、历史写库、请求结束复核都用它。
//! - [`Filter`]：流式状态机，逐 delta 产出可见正文。
//!
//! 两者对任意切分必须等价（`tests::arbitrary_splits_match_strip`）。

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Map, Value};

/// 围栏候选体上限。超过就放弃候选，按普通代码块补发。
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// 裸候选上限。正常布局不到 1 KiB，8 KiB 足够宽松。
pub const MAX_BARE_BYTES: usize = 8 * 1024;
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
    /// 块本身合法，但与当前配置不符（TUN 下的 `proxy_card`、已有节点时的 `source_choice`）。
    BlockNotApplicable,
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
            Reason::BlockNotApplicable => "block_not_applicable",
        }
    }
}

/// 形状判定：同时有 `version` 与 `blocks` 的对象。**不看类型**——
/// `"blocks": "oops"` 也是「模型想写布局」，漏到正文里才是事故。
pub fn is_layout_shape(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.contains_key("version") && object.contains_key("blocks"))
}

/// 整段解析 + 校验。返回规范化后的布局（`targets` 已 trim、去重）。
pub fn parse_and_validate(text: &str) -> Result<Value, Reason> {
    let value: Value = serde_json::from_str(text).map_err(|_| Reason::BadJson)?;
    validate(&value)
}

/// 写入那一刻的配置形态。语义校验只看这两条明确不可能成立的情况。
pub struct ConfigContext<'a> {
    pub connect_mode: &'a str,
    pub node_count: i64,
}

/// 结构校验 + 与配置的兼容性。后者只在写入时做：配置后来变了，渲染时跳过块即可。
pub fn validate_for(config: &ConfigContext<'_>, value: &Value) -> Result<Value, Reason> {
    let layout = validate(value)?;
    for block in layout["blocks"].as_array().into_iter().flatten() {
        match block["type"].as_str().unwrap_or_default() {
            "proxy_card" if config.connect_mode != crate::store::configs::CONNECTION_SYSTEM_PROXY => {
                return Err(Reason::BlockNotApplicable);
            }
            "source_choice" if config.node_count > 0 => {
                return Err(Reason::BlockNotApplicable);
            }
            _ => {}
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

/// 计数只用于评估提示词有没有收住，不决定行为。
static BARE_OK: AtomicU64 = AtomicU64::new(0);
static BARE_INVALID: AtomicU64 = AtomicU64::new(0);

/// `(bare_ok, bare_invalid)`。形状是布局且合法 / 形状是布局但非法。
pub fn bare_stats() -> (u64, u64) {
    (
        BARE_OK.load(Ordering::Relaxed),
        BARE_INVALID.load(Ordering::Relaxed),
    )
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

/// 行首裸 JSON：前导只有空白，第一个非空白字符是 `{`。返回 `{` 的字节偏移。
fn bare_start(content: &str) -> Option<usize> {
    let prefix = content
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .count();
    content[prefix..].starts_with('{').then_some(prefix)
}

enum BareStep {
    Open,
    Closed,
    Overflow,
}

/// 喂给 `feed_bare` 的结果，带「消费到哪个字节」。
enum BareProgress {
    Open,
    Closed(usize),
    Overflow(usize),
}

/// 裸对象的括号配对：识别 JSON 字符串与转义，不是简单数括号。
struct BareScan {
    /// 候选前面的行首空白：吞掉时一起吞，放行时一起放。
    leading: String,
    /// 从 `{` 开始的对象原文。
    body: String,
    depth: i32,
    in_string: bool,
    escaped: bool,
}

impl BareScan {
    /// 调用方已经看见行首的 `{`。
    fn start(leading: String) -> Self {
        Self {
            leading,
            body: "{".to_string(),
            depth: 1,
            in_string: false,
            escaped: false,
        }
    }

    fn step(&mut self, ch: char) -> BareStep {
        self.body.push(ch);
        if self.in_string {
            if self.escaped {
                self.escaped = false;
            } else if ch == '\\' {
                self.escaped = true;
            } else if ch == '"' {
                self.in_string = false;
            }
        } else {
            match ch {
                '"' => self.in_string = true,
                '{' => self.depth += 1,
                '}' => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        return BareStep::Closed;
                    }
                }
                _ => {}
            }
        }
        if self.body.len() > MAX_BARE_BYTES {
            return BareStep::Overflow;
        }
        BareStep::Open
    }
}

fn feed_bare(scan: &mut BareScan, text: &str) -> BareProgress {
    for (index, ch) in text.char_indices() {
        match scan.step(ch) {
            BareStep::Open => {}
            BareStep::Closed => return BareProgress::Closed(index + ch.len_utf8()),
            BareStep::Overflow => return BareProgress::Overflow(index + ch.len_utf8()),
        }
    }
    BareProgress::Open
}

fn emit_overflow(scan: &BareScan, out: &mut String) {
    log::warn!("layout.bare_too_large");
    out.push_str(&scan.leading);
    out.push_str(&scan.body);
}

/// 闭合的裸候选：形状是布局就吞掉（合法的写库），否则连前导空白一起放行。
fn conclude_bare(scan: BareScan, out: &mut String, layout: &mut Option<Value>) {
    match serde_json::from_str::<Value>(&scan.body) {
        Ok(value) if is_layout_shape(&value) => match validate(&value) {
            Ok(value) => {
                BARE_OK.fetch_add(1, Ordering::Relaxed);
                record_layout(value, layout, "layout.bare_ok");
            }
            Err(reason) => {
                BARE_INVALID.fetch_add(1, Ordering::Relaxed);
                log::warn!("layout.bare_invalid reason={}", reason.code());
            }
        },
        _ => {
            out.push_str(&scan.leading);
            out.push_str(&scan.body);
        }
    }
}

/// 未闭合的裸候选：永远不补发半截 JSON。能解析且形状是布局就采用。
fn discard_unclosed_bare(scan: BareScan, layout: &mut Option<Value>) {
    match serde_json::from_str::<Value>(&scan.body) {
        Ok(value) if is_layout_shape(&value) => match validate(&value) {
            Ok(value) => {
                BARE_OK.fetch_add(1, Ordering::Relaxed);
                record_layout(value, layout, "layout.bare_ok");
            }
            Err(reason) => log::warn!("layout.unclosed_invalid reason={}", reason.code()),
        },
        _ => log::warn!("layout.bare_unclosed"),
    }
}

fn record_layout(value: Value, layout: &mut Option<Value>, label: &str) {
    log::info!(
        "{label} blocks={}",
        value["blocks"].as_array().map_or(0, Vec::len)
    );
    *layout = Some(value);
}

/// 围栏候选是否「长得像布局」。是就吞掉，不合法只记原因码。
fn absorb_layout_like(text: &str, closed: bool, layout: &mut Option<Value>) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    if !is_layout_shape(&value) {
        return false;
    }
    match validate(&value) {
        Ok(value) => record_layout(value, layout, "layout.ok"),
        Err(reason) => {
            if closed {
                log::warn!("layout.invalid reason={}", reason.code());
            } else {
                log::warn!("layout.unclosed_invalid reason={}", reason.code());
            }
        }
    }
    true
}

/// 整段过滤：返回（可见正文，最后一份合法布局）。
pub fn strip(text: &str) -> (String, Option<Value>) {
    let mut out = String::new();
    let mut layout: Option<Value> = None;
    let mut mode = Mode::Prose;
    let mut candidate: Option<Candidate> = None;
    let mut bare: Option<BareScan> = None;

    for line in text.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        match mode {
            Mode::Prose => {
                if let Some(info) = opening_info(content) {
                    match classify(info) {
                        Kind::Ordinary => {
                            out.push_str(line);
                            mode = Mode::CodeFence;
                        }
                        kind => {
                            candidate = Some(Candidate::new(kind, line));
                            mode = Mode::Candidate;
                        }
                    }
                    continue;
                }
                if let Some(start) = bare_start(content) {
                    let mut scan = BareScan::start(content[..start].to_string());
                    match feed_bare(&mut scan, &line[start + 1..]) {
                        BareProgress::Open => {
                            bare = Some(scan);
                            mode = Mode::Bare;
                        }
                        BareProgress::Closed(end) => {
                            conclude_bare(scan, &mut out, &mut layout);
                            out.push_str(&line[start + 1 + end..]);
                        }
                        BareProgress::Overflow(end) => {
                            emit_overflow(&scan, &mut out);
                            out.push_str(&line[start + 1 + end..]);
                        }
                    }
                    continue;
                }
                out.push_str(line);
            }
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
            Mode::Bare => {
                let scan = bare.as_mut().expect("裸候选状态必有候选");
                match feed_bare(scan, line) {
                    BareProgress::Open => {}
                    BareProgress::Closed(end) => {
                        let scan = bare.take().expect("裸候选状态必有候选");
                        conclude_bare(scan, &mut out, &mut layout);
                        out.push_str(&line[end..]);
                        mode = Mode::Prose;
                    }
                    BareProgress::Overflow(end) => {
                        let scan = bare.take().expect("裸候选状态必有候选");
                        emit_overflow(&scan, &mut out);
                        out.push_str(&line[end..]);
                        mode = Mode::Prose;
                    }
                }
            }
        }
    }

    match mode {
        Mode::Candidate => {
            if let Some(candidate) = candidate.take() {
                conclude_unclosed(candidate, &mut out, &mut layout);
            }
        }
        Mode::Bare => {
            if let Some(scan) = bare.take() {
                discard_unclosed_bare(scan, &mut layout);
            }
        }
        Mode::Prose | Mode::CodeFence => {}
    }

    (out, layout)
}

/// 闭合的围栏候选：显式 `layout` 一律不显示；兼容候选只有长得像布局才吞掉。
fn conclude(
    candidate: Candidate,
    close_raw: Option<&str>,
    out: &mut String,
    layout: &mut Option<Value>,
) {
    let parsed = serde_json::from_str::<Value>(&candidate.body).ok();
    let shaped = parsed.as_ref().is_some_and(is_layout_shape);
    match candidate.kind {
        // `layout` 是显式声明，比形状更严：不论内容是什么都不进正文。
        Kind::Layout => {
            if !absorb_layout_like(&candidate.body, true, layout) {
                log::warn!("layout.invalid reason=bad_json");
            }
        }
        // `json` / 无标记围栏可能是举例或在讨论代码，只有形状像布局才吞。
        Kind::Compat if shaped => {
            absorb_layout_like(&candidate.body, true, layout);
        }
        Kind::Compat | Kind::Ordinary => {
            out.push_str(&candidate.opening);
            out.push_str(&candidate.body);
            if let Some(close) = close_raw {
                out.push_str(close);
            }
        }
    }
}

/// 未闭合的围栏候选：显式 `layout` 永远不显示（合法的照样生效）；
/// 兼容候选只有长得像布局才吞掉，否则按模型打出来的样子补发。
fn conclude_unclosed(mut candidate: Candidate, out: &mut String, layout: &mut Option<Value>) {
    // 流式路径下最后一行可能还没换行，闭合判定要在摘掉它之前做。
    let trailing_close = if is_close_line(&candidate.line) {
        let line = std::mem::take(&mut candidate.line);
        let cut = candidate.body.len().saturating_sub(line.len());
        candidate.body.truncate(cut);
        Some(line)
    } else {
        None
    };

    let shaped = serde_json::from_str::<Value>(&candidate.body)
        .ok()
        .as_ref()
        .is_some_and(is_layout_shape);
    match candidate.kind {
        Kind::Layout => {
            if !absorb_layout_like(&candidate.body, false, layout) {
                log::warn!("layout.unclosed_invalid reason=bad_json");
            }
        }
        Kind::Compat if shaped => {
            absorb_layout_like(&candidate.body, false, layout);
        }
        Kind::Compat | Kind::Ordinary => {
            out.push_str(&candidate.opening);
            out.push_str(&candidate.body);
            if let Some(close) = trailing_close {
                out.push_str(&close);
            }
        }
    }
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
    Bare,
}

/// 流式过滤器：逐 delta 喂入，返回本次可以显示的正文（可能为空串）。
pub struct Filter {
    mode: Mode,
    /// 行首缓冲：前导空白 + 可能的围栏起始前缀。
    line: String,
    at_line_start: bool,
    candidate: Option<Candidate>,
    bare: Option<BareScan>,
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
            bare: None,
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
                Mode::Bare => self.step_bare(ch, &mut out),
            }
        }
        out
    }

    /// 取消时的收尾：未闭合的候选（围栏与裸 JSON）整段丢弃，不补发半截 JSON。
    pub fn finish_discarding(&mut self) -> String {
        if matches!(self.mode, Mode::Candidate | Mode::Bare) {
            self.candidate = None;
            self.bare = None;
            self.mode = Mode::Prose;
            self.line.clear();
            self.at_line_start = true;
            return String::new();
        }
        self.finish()
    }

    /// 流结束：冲刷持有区、判定未闭合围栏与裸候选。
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
            Mode::Bare => {
                if let Some(scan) = self.bare.take() {
                    // 未闭合的裸候选永远不补发；能解析且形状是布局就采用。
                    discard_unclosed_bare(scan, &mut self.layout);
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

        // 行首：持有前导空白，直到第一个非空白字符能判定为止。
        let whitespace_only = self
            .line
            .chars()
            .all(|c| c == ' ' || c == '\t');
        if self.line.is_empty() || whitespace_only {
            match ch {
                ' ' | '\t' => {
                    self.line.push(ch);
                    return;
                }
                '\n' => {
                    let line = std::mem::take(&mut self.line);
                    out.push_str(&line);
                    out.push('\n');
                    return;
                }
                '{' => {
                    let leading = std::mem::take(&mut self.line);
                    self.bare = Some(BareScan::start(leading));
                    self.mode = Mode::Bare;
                    return;
                }
                '`' => {
                    self.line.push(ch);
                    return;
                }
                _ => {
                    let line = std::mem::take(&mut self.line);
                    out.push_str(&line);
                    out.push(ch);
                    self.at_line_start = false;
                    return;
                }
            }
        }

        // 行首已经出现反引号：判定是不是围栏起始行。
        let spaces = self.line.chars().take_while(|c| *c == ' ').count();
        let rest: String = self.line.chars().skip(spaces).collect();
        let ticks = rest.chars().take_while(|c| *c == '`').count();
        let indent_ok = spaces <= 3 && self.line.chars().take(spaces).all(|c| c == ' ');

        if ticks < 3 {
            // 1–2 个反引号：下一个字符不是反引号就不是围栏。
            if ch == '`' {
                self.line.push(ch);
            } else {
                let line = std::mem::take(&mut self.line);
                out.push_str(&line);
                out.push(ch);
                // 消费的可能是换行：下一行仍然是行首，否则裸 JSON 会被当成行内正文漏出。
                self.at_line_start = ch == '\n';
            }
            return;
        }

        if !indent_ok {
            // 缩进超过 3 个空格（或夹了制表符）：不是围栏，整行按正文走。
            let line = std::mem::take(&mut self.line);
            out.push_str(&line);
            out.push(ch);
            self.at_line_start = ch == '\n';
            return;
        }

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

    fn step_bare(&mut self, ch: char, out: &mut String) {
        let step = self
            .bare
            .as_mut()
            .expect("裸候选状态必有候选")
            .step(ch);
        match step {
            BareStep::Open => {}
            BareStep::Closed => {
                let scan = self.bare.take().expect("裸候选状态必有候选");
                conclude_bare(scan, out, &mut self.layout);
                self.mode = Mode::Prose;
                // 闭合的 `}` 之后还可能有余下的正文，仍在行内。
                self.at_line_start = false;
            }
            BareStep::Overflow => {
                let scan = self.bare.take().expect("裸候选状态必有候选");
                emit_overflow(&scan, out);
                self.mode = Mode::Prose;
                // 溢出恰好落在换行时，下一行仍是行首。
                self.at_line_start = ch == '\n';
            }
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
    fn json_fences_are_swallowed_only_when_the_body_looks_like_a_layout() {
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

    /// `layout` 是显式声明：坏 JSON 也不显示，否则用户会看到一个标着 layout 的
    /// 代码块里全是半截 JSON。
    #[test]
    fn a_layout_fence_with_broken_json_is_never_shown() {
        let text = "```layout\n{ \"version\": 1, \"blocks\": [ { \"type\": \"empty_hint\" }, ] }\n```\n";
        assert_eq!(strip_text(text), "");
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn a_layout_fence_with_plain_text_is_never_shown() {
        let text = "```layout\n这里不是 JSON\n```\n后面\n";
        assert_eq!(strip_text(text), "后面\n");
        assert!(strip(text).1.is_none());
    }

    /// 旧规则会显示「形状是布局但校验不过」的 json 围栏；现在统一为永远不显示。
    #[test]
    fn a_json_fence_with_a_layout_shape_but_invalid_blocks_is_still_swallowed() {
        let text = "```json\n{\"version\":1,\"blocks\":[{\"type\":\"nope\"}]}\n```\n";
        assert_eq!(strip_text(text), "");
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn unmarked_fences_are_candidates_too() {
        let text = "```\n{\"version\":1,\"blocks\":[]}\n```\n";
        assert_eq!(strip_text(text), "");
        assert_eq!(layout_of(text)["blocks"], json!([]));
    }

    #[test]
    fn a_bare_layout_on_its_own_line_is_swallowed() {
        let text = "已经连上了。\n\n{ \"version\": 1, \"blocks\": [ { \"type\": \"proxy_card\" } ] }\n\n需要换线路吗？\n";
        let visible = strip_text(text);
        assert!(!visible.contains("version"), "正文里不该出现布局：{visible:?}");
        assert_eq!(
            layout_of(text)["blocks"][0]["type"],
            json!("proxy_card")
        );
        assert!(visible.contains("已经连上了。"));
        assert!(visible.contains("需要换线路吗？"));
    }

    /// 判定看行首，不看前面有没有空行。
    #[test]
    fn a_bare_layout_right_after_a_label_line_is_swallowed() {
        let text = "布局：\n{\"version\":1,\"blocks\":[]}\n好了\n";
        assert_eq!(strip_text(text), "布局：\n\n好了\n");
        assert_eq!(layout_of(text)["blocks"], json!([]));
    }

    #[test]
    fn a_brace_in_the_middle_of_a_sentence_is_prose() {
        let text = "把 {\"version\":1} 发给我\n";
        assert_eq!(strip_text(text), text);
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn a_bare_layout_shape_with_invalid_content_is_swallowed() {
        let text = "前面\n{\"version\":1,\"blocks\":\"oops\"}\n后面\n";
        let visible = strip_text(text);
        assert!(!visible.contains("version"));
        assert!(visible.contains("前面"));
        assert!(visible.contains("后面"));
        assert!(strip(text).1.is_none(), "形状是布局但校验不过，不写库");
    }

    #[test]
    fn a_bare_json_that_is_not_layout_shaped_is_shown() {
        let text = "{\"a\":1}\n";
        assert_eq!(strip_text(text), text);
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn a_truncated_bare_layout_is_dropped_entirely() {
        let text = "前面\n{\"version\":1,\"blocks\":[";
        let visible = strip_text(text);
        assert_eq!(visible, "前面\n");
        assert!(!visible.contains('{'));
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn braced_strings_inside_a_bare_object_pair_correctly() {
        // 简单的数括号会在这里提前闭合；按 JSON 字符串规则配对才正确。
        let text =
            "{\"version\":1,\"blocks\":[{\"type\":\"reachability\",\"props\":{\"targets\":[\"a}b\"]}}]}\n";
        assert_eq!(strip_text(text), "\n");
        assert_eq!(
            layout_of(text)["blocks"][0]["props"]["targets"],
            json!(["a}b"])
        );

        let non_shape = "{\"a\":\"}\"}\n";
        assert_eq!(strip_text(non_shape), non_shape);
    }

    #[test]
    fn leading_whitespace_before_a_bare_layout_is_swallowed_with_it() {
        let text = "   {\"version\":1,\"blocks\":[]}\n";
        assert_eq!(strip_text(text), "\n");
    }

    #[test]
    fn bare_json_in_prose_is_not_mistaken_for_a_candidate() {
        let text = "布局长这样：{\"version\":1,\"blocks\":[]}，记住了吗？\n";
        assert_eq!(strip_text(text), text);
    }

    /// 1–2 个反引号的行会整行按正文放行；如果那一行以换行结束，下一行仍是行首。
    #[test]
    fn a_short_backtick_line_keeps_the_next_line_at_line_start() {
        let text = "`\n{\"version\":1,\"blocks\":[]}\n尾\n";
        assert_eq!(strip_text(text), "`\n\n尾\n");
        assert!(strip(text).1.is_some());

        let mut filter = Filter::new();
        let mut out = String::new();
        for ch in text.chars() {
            out.push_str(&filter.push(&ch.to_string()));
        }
        out.push_str(&filter.finish());
        assert_eq!(out, "`\n\n尾\n", "流式不能把下一行当行内正文发出去");
        assert!(filter.layout().is_some());
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
    fn an_unclosed_bare_object_never_leaks_half_json() {
        let text = "前面\n{\"version\":1,\"blocks\":[]";
        assert_eq!(strip_text(text), "前面\n");
        assert!(strip(text).1.is_none());
    }

    #[test]
    fn a_multiline_bare_layout_is_swallowed() {
        let text = "前面\n{\n  \"version\": 1,\n  \"blocks\": [ { \"type\": \"empty_hint\" } ]\n}\n后面\n";
        let visible = strip_text(text);
        assert!(!visible.contains("version"));
        assert!(visible.contains("前面"));
        assert!(visible.contains("后面"));
        assert_eq!(layout_of(text)["blocks"][0]["type"], json!("empty_hint"));
    }

    #[test]
    fn the_last_valid_layout_wins_and_all_fences_disappear() {
        let text = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"empty_hint\"}]}\n```\n中间\n{\"version\":1,\"blocks\":[{\"type\":\"proxy_card\"}]}\n";
        assert_eq!(strip_text(text), "中间\n\n");
        assert_eq!(layout_of(text)["blocks"][0]["type"], json!("proxy_card"));
    }

    #[test]
    fn an_invalid_later_layout_does_not_erase_an_earlier_valid_one() {
        let text = "```layout\n{\"version\":1,\"blocks\":[{\"type\":\"empty_hint\"}]}\n```\n```layout\n{\"version\":2}\n```\n";
        assert_eq!(layout_of(text)["blocks"][0]["type"], json!("empty_hint"));
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

    /// 语义校验只在写入时做：TUN 下 `proxy_card`、已有节点时 `source_choice` 整份丢弃。
    #[test]
    fn block_applicability_depends_on_the_config() {
        let proxy = json!({"version":1,"blocks":[{"type":"proxy_card"}]});
        let ctx = ConfigContext {
            connect_mode: "system_proxy",
            node_count: 0,
        };
        assert!(validate_for(&ctx, &proxy).is_ok());

        let tun = ConfigContext {
            connect_mode: "tun",
            node_count: 0,
        };
        assert_eq!(
            validate_for(&tun, &proxy),
            Err(Reason::BlockNotApplicable)
        );

        let source = json!({"version":1,"blocks":[{"type":"source_choice"}]});
        let empty = ConfigContext {
            connect_mode: "system_proxy",
            node_count: 0,
        };
        assert!(validate_for(&empty, &source).is_ok());
        let with_nodes = ConfigContext {
            connect_mode: "system_proxy",
            node_count: 2,
        };
        assert_eq!(
            validate_for(&with_nodes, &source),
            Err(Reason::BlockNotApplicable)
        );
    }

    #[test]
    fn oversized_fence_candidates_fall_back_to_a_code_block() {
        let body = "x".repeat(MAX_BODY_BYTES + 10);
        let text = format!("```layout\n{body}\n```\n尾\n");
        let out = strip_text(&text);
        assert!(out.contains("```layout"), "太大时按普通代码块显示");
        assert!(out.contains("尾"));
    }

    #[test]
    fn oversized_bare_candidates_fall_back_to_plain_text() {
        let body = format!("{{\"version\":1,\"blocks\":[{}", "x".repeat(MAX_BARE_BYTES + 10));
        let text = format!("{body}\n尾\n");
        let out = strip_text(&text);
        assert!(out.contains("{\"version\""), "超限后原样放行");
        assert!(out.contains("尾"));
    }

    #[test]
    fn stripping_is_idempotent() {
        for sample in [
            SAMPLE,
            "前面\n{\"version\":1,\"blocks\":[]}\n后面\n",
            "把 {\"version\":1} 发给我\n",
        ] {
            let once = strip_text(sample);
            assert_eq!(strip_text(&once), once);
        }
    }

    /// 流式全程不能出现 `{"version` 片段：候选闭合前一个字符都不发。
    #[test]
    fn streaming_never_leaks_a_layout_fragment() {
        let text = "已经连上了。\n\n{ \"version\": 1, \"blocks\": [ { \"type\": \"proxy_card\" } ] }\n\n需要换线路吗？\n";
        let mut filter = Filter::new();
        let mut emitted = String::new();
        for ch in text.chars() {
            emitted.push_str(&filter.push(&ch.to_string()));
            assert!(
                !emitted.contains("{\"version"),
                "流式过程中泄露了布局片段：{emitted:?}"
            );
        }
        emitted.push_str(&filter.finish());
        assert!(!emitted.contains("version"));
        assert!(filter.layout().is_some());
    }

    /// 取消时未闭合的候选（围栏与裸 JSON）都不补发。
    #[test]
    fn cancelling_discards_unclosed_candidates() {
        let mut filter = Filter::new();
        assert_eq!(filter.push("正在写\n```json\n{\"a\":"), "正在写\n");
        assert_eq!(filter.finish_discarding(), "");

        let mut filter = Filter::new();
        assert_eq!(filter.push("正在写\n```json\n{\"a\":"), "正在写\n");
        assert_eq!(filter.finish(), "```json\n{\"a\":");

        let mut filter = Filter::new();
        assert_eq!(filter.push("正在写\n{\"version\":1,"), "正在写\n");
        assert_eq!(filter.finish_discarding(), "");
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
            "已经连上了。\n\n{ \"version\": 1, \"blocks\": [ { \"type\": \"proxy_card\" } ] }\n\n需要换线路吗？\n".to_string(),
            "布局：\n{\"version\":1,\"blocks\":[]}\n好了\n".to_string(),
            "把 {\"version\":1} 发给我\n".to_string(),
            "{\"a\":1}\n".to_string(),
            "   {\"version\":1,\"blocks\":[]}\n".to_string(),
            "`\n{\"version\":1,\"blocks\":[]}\n尾\n".to_string(),
            "    ```\n{\"version\":1,\"blocks\":[]}\n尾\n".to_string(),
            "{".to_string() + &"x".repeat(MAX_BARE_BYTES - 1) + "\n{\"version\":1,\"blocks\":[]}\n尾\n",
            "前面\n{\"version\":1,\"blocks\":[".to_string(),
            "{\"a\":\"}\",\"version\":1,\"blocks\":[]}\n".to_string(),
            "{\"blocks\":[],\"version\":1}\n尾".to_string(),
            "```layout\n{\"a\":1}\n```\n尾\n".to_string(),
            "```json\n{\"version\":1,\"blocks\":[{\"type\":\"nope\"}]}\n```\n尾\n".to_string(),
            "前面\n{\n  \"version\": 1,\n  \"blocks\": [ { \"type\": \"empty_hint\" } ]\n}\n后面\n".to_string(),
            "{".to_string(),
            "   {".to_string(),
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

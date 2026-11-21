//! 提示词与内容文档。
//!
//! 两件事，两条存放路径：
//!
//! 1. **提示词正文**（`system.md` / `kickoff.md`）编译进二进制——离线也能用，
//!    运行时不依赖仓库里的文件；
//! 2. **内容文档**（`product.md` / `faq.md`）在启动时释放到应用数据目录，
//!    系统提示词里只写路径，AI 需要时自己用文件工具去读，不整段塞进上下文。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

/// 默认语言。读不到设置、语言值缺失时按它处理。
pub const DEFAULT_LANG: &str = "zh";

/// 随包的语言。两套都释放；会话按设置里的 resolved 值选一套。
const RELEASED_LANGS: [&str; 2] = ["zh", "en"];

const SYSTEM_ZH: &str = include_str!("../../../resources/prompts/zh/system.md");
const KICKOFF_ZH: &str = include_str!("../../../resources/prompts/zh/kickoff.md");
const PRODUCT_ZH: &str = include_str!("../../../resources/prompts/zh/product.md");
const FAQ_ZH: &str = include_str!("../../../resources/prompts/zh/faq.md");
const SYSTEM_EN: &str = include_str!("../../../resources/prompts/en/system.md");
const KICKOFF_EN: &str = include_str!("../../../resources/prompts/en/kickoff.md");
const PRODUCT_EN: &str = include_str!("../../../resources/prompts/en/product.md");
const FAQ_EN: &str = include_str!("../../../resources/prompts/en/faq.md");

/// 一份已释放的语言目录。
pub struct Released {
    pub lang: String,
    pub dir: PathBuf,
    /// 本目录全部文件的内容哈希前 8 位，日志里对账用。
    pub version: String,
}

/// 系统提示词正文。没有这一种语言时返回 `None`——不拿中文顶替。
pub fn system(lang: &str) -> Option<&'static str> {
    match lang {
        "zh" => Some(strip_header(SYSTEM_ZH)),
        "en" => Some(strip_header(SYSTEM_EN)),
        _ => None,
    }
}

/// 首启开场用的用户提示词正文。没有这一种语言时返回 `None`。
pub fn kickoff(lang: &str) -> Option<&'static str> {
    match lang {
        "zh" => Some(strip_header(KICKOFF_ZH)),
        "en" => Some(strip_header(KICKOFF_EN)),
        _ => None,
    }
}

/// 内容文档：语言目录里固定这几份。
fn content_docs(lang: &str) -> &'static [(&'static str, &'static str)] {
    match lang {
        "zh" => &[("product.md", PRODUCT_ZH), ("faq.md", FAQ_ZH)],
        "en" => &[("product.md", PRODUCT_EN), ("faq.md", FAQ_EN)],
        _ => &[],
    }
}

/// 去掉文件顶部的构建说明注释：注释是写给维护者的，不进提示词。
fn strip_header(raw: &'static str) -> &'static str {
    if !raw.trim_start().starts_with("<!--") {
        return raw;
    }
    match raw.find("-->") {
        Some(index) => raw[index + 3..].trim_start(),
        None => raw,
    }
}

static RELEASED: OnceLock<Vec<Released>> = OnceLock::new();

/// 启动时调用一次：释放所有语言的提示词与内容文档。
///
/// 重复调用只做一次（`OnceLock`）；想重新释放走 `release`。
pub fn install(data_dir: &Path) -> &'static Released {
    released_from(data_dir, DEFAULT_LANG)
}

/// 指定语言已释放的目录与版本。语言不认识时回落到默认语言。
pub fn released(lang: &str) -> &'static Released {
    released_from(&crate::runtime::default_app_data_dir(), lang)
}

fn released_from(data_dir: &Path, lang: &str) -> &'static Released {
    let all = RELEASED.get_or_init(|| {
        let mut all: Vec<Released> = RELEASED_LANGS
            .iter()
            .filter(|lang| **lang != DEFAULT_LANG)
            .map(|lang| release(data_dir, lang))
            .collect();
        all.push(release(data_dir, DEFAULT_LANG));
        all
    });
    all.iter()
        .find(|released| released.lang == lang)
        .or_else(|| all.iter().find(|released| released.lang == DEFAULT_LANG))
        .expect("默认语言总会被释放")
}

/// 把一种语言的提示词释放到 `<data_dir>/prompts/<lang>/`，返回目录与版本。
///
/// **内容变了才写盘**：每次启动都覆盖会把修改时间整片刷新，排查时看不出是哪次变的。
pub fn release(data_dir: &Path, lang: &str) -> Released {
    let dir = data_dir.join("prompts").join(lang);
    let mut hasher = Sha256::new();

    let mut files: Vec<(&str, &str)> = Vec::new();
    if let Some(text) = system(lang) {
        files.push(("system.md", text));
    }
    if let Some(text) = kickoff(lang) {
        files.push(("kickoff.md", text));
    }
    files.extend(content_docs(lang).iter().copied());

    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!("提示词目录创建失败 {}：{error}", dir.display());
    }
    for (name, body) in &files {
        // 文件名也进哈希：改名的内容换了一份文件，版本同样该变。
        hasher.update(name.as_bytes());
        hasher.update(body.as_bytes());
        write_if_changed(&dir.join(name), body);
    }

    Released {
        lang: lang.to_string(),
        dir,
        version: hex::encode(hasher.finalize())[..8].to_string(),
    }
}

fn write_if_changed(path: &Path, body: &str) {
    if std::fs::read_to_string(path)
        .map(|existing| existing == body)
        .unwrap_or(false)
    {
        return;
    }
    if let Err(error) = std::fs::write(path, body) {
        // 写不进去不是致命错误：路径会照常写进系统提示词，AI 读不到就如实说。
        log::warn!("提示词写入失败 {}：{error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-prompts-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn both_languages_carry_a_system_and_a_kickoff_prompt() {
        assert!(system("zh").unwrap().starts_with("# 你是谁"));
        assert!(kickoff("zh").unwrap().starts_with("# 首次配置"));
        // 英文是完整的一份，不是拿中文顶替；正文同样以一级标题开头。
        let system_en = system("en").expect("英文系统提示词已随包提供");
        assert!(system_en.starts_with("# "), "英文系统提示词要以一级标题开头");
        assert!(system_en.contains("# Who you are"));
        let kickoff_en = kickoff("en").expect("英文首启提示词已随包提供");
        assert!(kickoff_en.starts_with("# "), "英文首启提示词要以一级标题开头");
        assert!(kickoff_en.contains("# First-run setup"));
        // 头部注释是给维护者的，不能进提示词。
        for text in [system("zh").unwrap(), kickoff("zh").unwrap(), system_en, kickoff_en] {
            assert!(!text.contains("<!--"), "文件头注释不该进提示词");
        }
        // 首启文本不经过渲染，不能带占位符；系统提示词里的占位符由 render 填空。
        assert!(!kickoff("zh").unwrap().contains("{{"));
        assert!(!kickoff_en.contains("{{"));
        // 不认识的语言仍然返回 None，不回落中文。
        assert!(system("fr").is_none());
        assert!(kickoff("fr").is_none());
    }

    /// 标题层级序列（`#` 的数量）。只认行首、`#` 后跟一个空格的标题。
    fn heading_levels(text: &str) -> Vec<usize> {
        text.lines()
            .filter_map(|line| {
                let trimmed = line.trim_start();
                let level = trimmed.chars().take_while(|c| *c == '#').count();
                (level > 0 && trimmed.chars().nth(level) == Some(' ')).then_some(level)
            })
            .collect()
    }

    /// `{{NAME}}` 占位符集合，排序去重。
    fn placeholders(text: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("{{") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else {
                break;
            };
            found.push(format!("{{{{{}}}}}", &after[..end]));
            rest = &after[end + 2..];
        }
        found.sort();
        found.dedup();
        found
    }

    /// 两种语言必须同构：标题层级序列与占位符集合一致。
    /// 翻译可以换词，但不能多一节、少一节，或漏掉 Host 要渲染的占位符。
    #[test]
    fn both_languages_share_the_same_prompt_structure() {
        for (name, zh, en) in [
            ("system.md", system("zh").unwrap(), system("en").unwrap()),
            ("kickoff.md", kickoff("zh").unwrap(), kickoff("en").unwrap()),
        ] {
            let zh_headings = heading_levels(zh);
            assert!(!zh_headings.is_empty(), "{name} 没有标题");
            assert_eq!(
                zh_headings,
                heading_levels(en),
                "{name} 的标题层级序列不一致（zh vs en）"
            );
            assert_eq!(
                placeholders(zh),
                placeholders(en),
                "{name} 的占位符集合不一致（zh vs en）"
            );
        }
    }

    #[test]
    fn releasing_writes_every_file_for_both_languages() {
        let dir = temp_dir();
        let zh = release(&dir, "zh");
        for name in ["system.md", "kickoff.md", "product.md", "faq.md"] {
            assert!(
                dir.join("prompts/zh").join(name).exists(),
                "缺少 {name}"
            );
        }
        assert_eq!(std::fs::read_to_string(zh.dir.join("system.md")).unwrap(), system("zh").unwrap());

        let en = release(&dir, "en");
        for name in ["system.md", "kickoff.md", "product.md", "faq.md"] {
            assert!(dir.join("prompts/en").join(name).exists(), "缺少 en/{name}");
        }
        assert_eq!(
            std::fs::read_to_string(en.dir.join("system.md")).unwrap(),
            system("en").unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(en.dir.join("kickoff.md")).unwrap(),
            kickoff("en").unwrap()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 版本只由内容决定；同样的内容重复释放得到同一个版本。
    #[test]
    fn the_version_is_stable_and_only_eight_characters() {
        let dir = temp_dir();
        let first = release(&dir, "zh");
        let second = release(&dir, "zh");
        assert_eq!(first.version, second.version);
        assert_eq!(first.version.len(), 8);
        assert!(first.version.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 磁盘上的文件被改坏或删掉时，下次释放会恢复成编进二进制的那一份。
    #[test]
    fn a_modified_file_is_restored_on_the_next_release() {
        let dir = temp_dir();
        release(&dir, "zh");
        let product = dir.join("prompts/zh/product.md");
        std::fs::write(&product, "被改坏了").unwrap();
        std::fs::remove_file(dir.join("prompts/zh/faq.md")).unwrap();

        release(&dir, "zh");
        assert_eq!(
            std::fs::read_to_string(&product).unwrap(),
            content_docs("zh")[0].1
        );
        assert!(dir.join("prompts/zh/faq.md").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_language_releases_nothing() {
        let dir = temp_dir();
        let released = release(&dir, "fr");
        assert!(!released.dir.join("system.md").exists());
        assert!(!released.dir.join("product.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

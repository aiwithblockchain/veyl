//! 用户级 LaunchAgent 的安装与唤醒（`com.veyl.proxyguard`）。
//!
//! 每次 `enable()` 都调一次：plist 里的路径按当前 `current_exe()` 的同级目录生成，
//! App 被移动或开发构建换路径后自动跟上（见设计稿 §3.2）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::lease::LeasePaths;

const LABEL: &str = "com.veyl.proxyguard";
const GUARD_BINARY: &str = "veyl-proxy-guard";

pub fn ensure_running(data_dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("读取当前可执行文件失败：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "当前可执行文件没有父目录".to_string())?;
    let guard = dir.join(GUARD_BINARY);
    if !guard.is_file() {
        return Err(format!(
            "包里没有看门狗二进制（{}）；崩溃后的代理只能等下次启动恢复",
            guard.display()
        ));
    }

    let paths = LeasePaths::in_dir(data_dir);
    let logs = crate::veyl_paths::proxy_logs_dir(data_dir);
    fs::create_dir_all(&logs).map_err(|e| format!("创建看门狗日志目录失败：{e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&logs, fs::Permissions::from_mode(0o755));
    }

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME 未设置，无法定位 LaunchAgents".to_string())?;
    let agents = home.join("Library").join("LaunchAgents");
    fs::create_dir_all(&agents).map_err(|e| format!("创建 LaunchAgents 目录失败：{e}"))?;
    let plist = agents.join(format!("{LABEL}.plist"));
    let content = render_plist(&guard, &paths, &logs.join("proxy-guard.log"));

    let changed = fs::read_to_string(&plist)
        .map(|existing| existing != content)
        .unwrap_or(true);
    if changed {
        fs::write(&plist, &content).map_err(|e| format!("写入 {} 失败：{e}", plist.display()))?;
    }

    let domain = domain();
    if changed {
        // 路径变了：先把旧任务摘掉，bootstrap 才会用新 plist。
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("{domain}/{LABEL}")])
            .output();
    }
    // 已加载时 bootstrap 会失败（EEXIST 类），下一次 kickstart 能正常起任务；
    // 只有「刚改过 plist」时 bootstrap 失败才值得记一条：那可能意味着旧 label
    // 还挂着，后面的 kickstart 起的是旧任务。
    let bootstrap = Command::new("/bin/launchctl")
        .args(["bootstrap", &domain, &plist.to_string_lossy()])
        .output();
    if changed {
        match bootstrap {
            Ok(output) if !output.status.success() => log::warn!(
                "launchctl bootstrap 未成功（{}）：{}",
                plist.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => log::warn!("执行 launchctl bootstrap 失败：{error}"),
            _ => {}
        }
    }

    let output = Command::new("/bin/launchctl")
        .args(["kickstart", "-k", &format!("{domain}/{LABEL}")])
        .output()
        .map_err(|e| format!("执行 launchctl kickstart 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "launchctl kickstart 未成功：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

fn render_plist(guard: &Path, paths: &LeasePaths, log: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{guard}</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>{lock}</string>
    <string>{lease}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = LABEL,
        guard = escape(&guard.to_string_lossy()),
        lock = escape(&paths.lease_lock().to_string_lossy()),
        lease = escape(&paths.lease().to_string_lossy()),
        log = escape(&log.to_string_lossy()),
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_points_at_the_sibling_binary_and_the_lease_files() {
        let paths = LeasePaths::in_dir("/Users/example/.veyl");
        let text = render_plist(
            Path::new("/Applications/Veyl.app/Contents/MacOS/veyl-proxy-guard"),
            &paths,
            Path::new("/Users/example/.veyl/logs/proxy-guard.log"),
        );
        assert!(text.contains("<string>com.veyl.proxyguard</string>"));
        assert!(text.contains(
            "<string>/Applications/Veyl.app/Contents/MacOS/veyl-proxy-guard</string>"
        ));
        assert!(text.contains("/Users/example/.veyl/proxy-lease.lock"));
        assert!(text.contains("/Users/example/.veyl/proxy-lease.json"));
        assert!(text.contains("<key>SuccessfulExit</key>"));
        assert!(text.contains("/Users/example/.veyl/logs/proxy-guard.log"));
    }

    #[test]
    fn xml_special_characters_are_escaped() {
        assert_eq!(escape("a&b<c>d\"e"), "a&amp;b&lt;c&gt;d&quot;e");
    }
}

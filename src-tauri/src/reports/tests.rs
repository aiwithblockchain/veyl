use super::*;

/// 报告模块的测试共享内存登记表，必须串行：并行跑会互相清空，
/// 让「同一会话复用目录」这类断言偶发失败。
static REPORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    REPORT_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "veyl-report-{tag}-{:016x}",
        rand::random::<u64>()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn context(data_dir: &Path) -> ReportContext {
    ReportContext {
        data_dir: data_dir.to_path_buf(),
        runtime: json!({
            "state": "running",
            "mode": "tun",
            "mixed_port": 7890,
            "system_dns": "tunnel",
            "connected_since": "2026-11-12T07:00:00Z",
            "uptime_seconds": 120,
            "upstream_version": "1.14.4",
            "runtime_source": "bundled",
            "health": {
                "process": true, "clash_api": false, "data_plane": false,
                "consecutive_failures": 0, "checked_at": "2026-11-12T07:01:00Z"
            },
            "last_error": {
                "code": "RUNTIME_EXITED",
                "message": "连接 www.google.com 失败，服务器 203.0.113.10:8388",
                "details": { "reason": "upstream_timeout" }
            },
        }),
        checks: json!([{
            "id": "network.exit_ip",
            "ok": true,
            "detail": "出口 203.0.113.9，探测 cp.cloudflare.com"
        }]),
        app_version: "0.1.0".into(),
        platform: "darwin".into(),
        arch: "aarch64".into(),
        routing_mode: Some("proxy_all".into()),
        node_count: 1,
        config_count: 1,
        node_protocols: vec!["shadowsocks".into()],
        node_hosts: vec!["203.0.113.10".into()],
        node_names: vec!["东京 01".into()],
        config_names: vec!["我的订阅".into()],
        user_allows_domains: false,
    }
}

/// `report_dir` 是给模型看的形式（`~` 或目录名），测试用目录名找真实目录。
fn generated_dir(root: &Path, data: &Value) -> PathBuf {
    let shown = Path::new(data["report_dir"].as_str().unwrap());
    root.join(shown.file_name().unwrap())
}

fn input(markdown: Option<&str>) -> IssueReportInput {
    IssueReportInput {
        log_lines: 200,
        include_domains: None,
        report_markdown: markdown.map(str::to_string),
    }
}

/// 未知字段 / 越界一律拒绝，且不创建任何目录（契约 §4.46）。
#[test]
fn out_of_range_or_unknown_arguments_are_rejected() {
    let _serial = serial();
    for input in [
        json!({ "path": "/etc/passwd" }),
        json!({ "include_domains": "yes" }),
    ] {
        assert_eq!(parse_input(&input), Err("unknown_argument".to_string()), "{input}");
    }
    // 参数名认识、取值非法：独立 reason，方便调用方纠正。
    for input in [
        json!({ "log_lines": 1000 }),
        json!({ "log_lines": 39 }),
        json!({ "log_lines": "200" }),
    ] {
        assert_eq!(
            parse_input(&input),
            Err("log_lines_out_of_range".to_string()),
            "{input}"
        );
    }
    assert!(parse_input(&json!({ "log_lines": 40 })).is_ok());
    assert!(parse_input(&json!({ "log_lines": 400 })).is_ok());
    // 空报告没有意义：拒绝，而不是写一份空文件。
    assert_eq!(
        parse_input(&json!({ "report_markdown": "   " })),
        Err("empty_report".to_string())
    );
}

#[test]
fn a_collected_report_lists_missing_logs_without_failing() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("missing");
    let data_dir = temp_root("data");
    let data = generate("s1", &input(None), &context(&data_dir), &root).unwrap();

    assert_eq!(data["phase"], "collected");
    assert_eq!(data["ai_report"], false);
    let files = data["files"].as_array().unwrap();
    // 数据目录里没有任何日志：全部标记 missing，但报告照常生成。
    let missing: Vec<&Value> = files
        .iter()
        .filter(|file| file["missing"] == true)
        .collect();
    assert!(!missing.is_empty());
    assert!(data["materials"]["logs"].as_array().unwrap().is_empty());
    assert!(generated_dir(&root, &data).join("报告.md").is_file());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 现场 JSON 里的错误消息也要脱敏：域名、节点地址都不出现。
#[test]
fn the_scene_json_is_redacted() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("scene");
    let data_dir = temp_root("data");
    let data = generate("s2", &input(None), &context(&data_dir), &root).unwrap();
    let dir = generated_dir(&root, &data);
    let scene = fs::read_to_string(dir.join("现场.json")).unwrap();

    assert!(!scene.contains("203.0.113.10"), "{scene}");
    assert!(!scene.contains("www.google.com"), "{scene}");
    assert!(scene.contains("***.google.com"), "{scene}");
    assert!(scene.contains("\"redaction_marker\": \"***\""), "{scene}");
    assert!(scene.contains("\"domains_included\": false"), "{scene}");
    // 节点/配置名不进入现场 JSON。
    assert!(!scene.contains("东京"), "{scene}");
    assert!(!scene.contains("我的订阅"), "{scene}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 模型传 include_domains 也要被用户的开关收窄。
#[test]
fn the_model_cannot_widen_domain_redaction() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("widen");
    let data_dir = temp_root("data");
    let mut ctx = context(&data_dir);
    ctx.user_allows_domains = false;
    let mut argument = input(None);
    argument.include_domains = Some(true);

    let data = generate("s3", &argument, &ctx, &root).unwrap();
    assert_eq!(data["materials"]["domains_included"], false);
    let dir = generated_dir(&root, &data);
    let scene = fs::read_to_string(dir.join("现场.json")).unwrap();
    assert!(!scene.contains("www.google.com"), "{scene}");
    assert!(scene.contains("***.google.com"), "{scene}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 同一会话复用目录，换会话才新建（同分钟第二个是 `-2`）。
#[test]
fn one_directory_per_session_and_suffix_on_collision() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("sessions");
    let data_dir = temp_root("data");
    let ctx = context(&data_dir);

    let first = generate("sA", &input(None), &ctx, &root).unwrap();
    let second = generate("sA", &input(Some("# 问题报告\n\n## 现象\nx")), &ctx, &root).unwrap();
    assert_eq!(first["report_id"], second["report_id"], "同一会话必须复用");
    assert_eq!(second["phase"], "written");
    assert_eq!(second["ai_report"], true);

    let other = generate("sB", &input(None), &ctx, &root).unwrap();
    assert_ne!(first["report_dir"], other["report_dir"]);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 目录同名时只加后缀，已有内容绝不被覆盖。
#[test]
fn a_collision_does_not_overwrite_the_existing_report() {
    let _serial = serial();
    use chrono::TimeZone;

    let root = temp_root("collide");
    let now = chrono::Local
        .with_ymd_and_hms(2026, 11, 12, 15, 30, 0)
        .unwrap();
    let staging = create_staging_dir(&root).unwrap();
    fs::write(staging.join("报告.md"), "第一份").unwrap();
    let first = commit_staging(&staging, &root, now).unwrap();
    let second = commit_staging(&create_staging_dir(&root).unwrap(), &root, now).unwrap();
    let third = commit_staging(&create_staging_dir(&root).unwrap(), &root, now).unwrap();

    assert!(first.ends_with("2026-11-12-1530"));
    assert!(second.ends_with("2026-11-12-1530-2"));
    assert!(third.ends_with("2026-11-12-1530-3"));
    assert_eq!(fs::read_to_string(first.join("报告.md")).unwrap(), "第一份");
    let _ = fs::remove_dir_all(&root);
}

/// 单份日志超 2 MiB 时只留尾部并标记 truncated。
#[test]
fn an_oversized_log_is_truncated_not_copied_whole() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("biglog");
    let data_dir = temp_root("data");
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    let path = crate::logging::log_path(&log_dir);
    let mut file = File::create(&path).unwrap();
    let line = "x".repeat(100);
    for index in 0..30_000 {
        writeln!(file, "{index:05} {line}").unwrap();
    }
    drop(file);

    let mut argument = input(None);
    argument.log_lines = 400;
    let data = generate("s4", &argument, &context(&data_dir), &root).unwrap();
    let entry = data["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["missing"] == false && file["lines"].is_number())
        .cloned()
        .unwrap();
    assert_eq!(entry["truncated"], true);
    assert!(entry["bytes"].as_u64().unwrap() <= LOG_FILE_LIMIT);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 四份日志合计不超过 8 MiB。
#[test]
fn the_total_written_size_stays_within_the_cap() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("total");
    let data_dir = temp_root("data");
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    let helper_dir = crate::veyl_paths::helper_logs_dir(&data_dir);
    fs::create_dir_all(&helper_dir).unwrap();

    let big = "y".repeat(1024);
    for (path, count) in [
        (crate::logging::log_path(&log_dir), 2500),
        (log_dir.join("runtime-1.14.4.log"), 2500),
        (helper_dir.join("helper.log"), 2500),
        (helper_dir.join("sing-box.log"), 2500),
    ] {
        let mut file = File::create(&path).unwrap();
        for _ in 0..count {
            writeln!(file, "{big}").unwrap();
        }
    }

    let data = generate("s5", &input(None), &context(&data_dir), &root).unwrap();
    let total: u64 = data["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|file| file["bytes"].as_u64())
        .sum();
    assert!(total <= TOTAL_LIMIT, "总量超限：{total}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 伪造的 report_id 直接 NOT_FOUND，不会执行任何 open。
#[test]
fn forged_report_ids_are_rejected() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("forged");
    for report_id in ["", "rpt-20260101-000000-abcdef", "../etc", "a/b"] {
        let reveal = reveal(report_id, &root).unwrap_err();
        assert_eq!(reveal.code, "NOT_FOUND", "{report_id}");
        let mail = compose_mail(report_id, &root).unwrap_err();
        assert_eq!(mail.code, "NOT_FOUND", "{report_id}");
    }
    let _ = fs::remove_dir_all(&root);
}

/// 只有登记过的 id 才能被找回，且第二个阶段之后按钮仍可用。
#[test]
fn a_registered_report_can_be_looked_up_after_a_restart() {
    let _serial = serial();
    reset_registry_for_test();
    let root = temp_root("lookup");
    let data_dir = temp_root("data");
    let data = generate("s6", &input(None), &context(&data_dir), &root).unwrap();
    let report_id = data["report_id"].as_str().unwrap().to_string();
    let dir = generated_dir(&root, &data);

    // 模拟重启：清空内存登记后仍能从 `.report-id` 找回。
    reset_registry_for_test();
    assert_eq!(lookup(&report_id, &root), Some(dir));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 「复制正文」兜底需要正文本身：只有打不开邮件客户端时才回传。
#[test]
fn the_mail_command_returns_the_body_only_when_it_cannot_open() {
    let _serial = serial();
    let dir = PathBuf::from("/tmp/report");
    let failed = mail_action(&dir, "正文", false);
    assert_eq!(failed["opened"], false);
    assert_eq!(failed["method"], "copy_only");
    assert_eq!(failed["body"], "正文");
    assert_eq!(failed["body_chars"], 2);

    let opened = mail_action(&dir, "正文", true);
    assert_eq!(opened["method"], "mail_client");
    assert!(opened["body"].is_null(), "{opened}");
}

/// 进模型的材料必须已经脱敏：快照与诊断里的域名、节点地址都不能原样出现。
#[test]
fn materials_are_redacted_before_reaching_the_model() {
    let _serial = serial();
    let root = temp_root("materials");
    let data_dir = temp_root("data");
    let data = generate("s7", &input(None), &context(&data_dir), &root).unwrap();
    let materials = data["materials"].to_string();

    assert!(!materials.contains("www.google.com"), "{materials}");
    assert!(!materials.contains("203.0.113.10"), "{materials}");
    assert!(!materials.contains("203.0.113.9"), "{materials}");
    assert!(!materials.contains("cp.cloudflare.com"), "{materials}");
    assert!(materials.contains("***"), "{materials}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 省略 include_domains = 遵循用户设置；显式 false 才是模型收窄。
#[test]
fn include_domains_follows_the_user_unless_the_model_narrows() {
    let _serial = serial();
    let root = temp_root("domains");
    let data_dir = temp_root("data");
    let mut ctx = context(&data_dir);
    ctx.user_allows_domains = true;

    let omitted = generate("s8", &input(None), &ctx, &root).unwrap();
    assert_eq!(omitted["materials"]["domains_included"], true);

    let mut narrowed = input(None);
    narrowed.include_domains = Some(false);
    let data = generate("s8", &narrowed, &ctx, &root).unwrap();
    assert_eq!(data["materials"]["domains_included"], false);

    let mut explicit = input(None);
    explicit.include_domains = Some(true);
    let data = generate("s8", &explicit, &ctx, &root).unwrap();
    assert_eq!(data["materials"]["domains_included"], true);

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 模型产出的报告缺标题或披露句时由 Host 补齐，不能靠模型自觉。
#[test]
fn a_report_missing_the_preamble_gets_it_from_the_host() {
    let _serial = serial();
    let root = temp_root("structure");
    let data_dir = temp_root("data");
    let data = generate(
        "s9",
        &input(Some("## 现象\n连不上。")),
        &context(&data_dir),
        &root,
    )
    .unwrap();
    let dir = generated_dir(&root, &data);
    let report = fs::read_to_string(dir.join("报告.md")).unwrap();
    assert!(report.starts_with("# 问题报告"), "{report}");
    assert!(report.contains("只保存在本机"), "{report}");
    for heading in ["## 现象", "## 环境", "## 时间线", "## 可疑点", "## 下一步建议"] {
        assert!(report.contains(heading), "缺 {heading}：{report}");
    }
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 给模型的 `report_dir` 不能是绝对路径（会把用户名带进聊天）。
#[test]
fn the_reported_directory_is_never_absolute() {
    let _serial = serial();
    let root = temp_root("nodir");
    let data_dir = temp_root("data");
    let data = generate("s10", &input(None), &context(&data_dir), &root).unwrap();
    let shown = data["report_dir"].as_str().unwrap();
    assert!(!shown.starts_with('/'), "{shown}");
    assert!(!shown.contains("Users"), "{shown}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 写入是原子的：成功后不留临时目录，根目录下只有正式目录。
#[test]
fn a_successful_report_leaves_no_staging_directory() {
    let _serial = serial();
    let root = temp_root("staging");
    let data_dir = temp_root("data");
    let _ = generate("s11", &input(None), &context(&data_dir), &root).unwrap();
    let leftovers: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "留下了临时目录：{leftovers:?}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// `lookup` 不跟随符号链接：指向报告目录的链接不能被当成登记过的报告。
#[cfg(unix)]
#[test]
fn lookup_does_not_follow_symlinked_report_directories() {
    let _serial = serial();
    let root = temp_root("symlink");
    let data_dir = temp_root("data");
    let data = generate("s12", &input(None), &context(&data_dir), &root).unwrap();
    let real = generated_dir(&root, &data);
    let link = root.join("linked");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    reset_registry_for_test();

    let report_id = data["report_id"].as_str().unwrap();
    assert_eq!(lookup(report_id, &root), Some(real));
    assert!(reveal("rpt-20260101-000000-ffffff", &root).is_err());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 写入阶段只覆盖 报告.md：日志逐字节不变，行号引用不会漂移。
#[test]
fn the_write_phase_leaves_logs_and_line_numbers_untouched() {
    let _serial = serial();
    let root = temp_root("lines");
    let data_dir = temp_root("data");
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).unwrap();
    let app_log = crate::logging::log_path(&log_dir);
    let mut file = File::create(&app_log).unwrap();
    for index in 0..50 {
        writeln!(file, "第 {index} 行").unwrap();
    }
    drop(file);

    let ctx = context(&data_dir);
    let first = generate("s17", &input(None), &ctx, &root).unwrap();
    let dir = generated_dir(&root, &first);
    let copied = dir
        .join("日志")
        .join(app_log.file_name().unwrap());
    let before = fs::read(&copied).unwrap();
    let before_lines = first["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"].as_str().unwrap().starts_with("日志/"))
        .and_then(|entry| entry["lines"].as_u64())
        .unwrap();

    let second = generate(
        "s17",
        &input(Some("# 问题报告\n\n## 现象\n连不上。")),
        &ctx,
        &root,
    )
    .unwrap();
    assert_eq!(first["report_id"], second["report_id"]);
    assert_eq!(before, fs::read(&copied).unwrap(), "日志被重写了");
    let after_lines = second["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == first["files"].as_array().unwrap()[0]["name"])
        .and_then(|entry| entry["lines"].as_u64())
        .unwrap();
    assert_eq!(before_lines, after_lines, "行数（行号基准）变了");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 材料里不出现配置名 / 节点名，也不出现「当前配置：…」这类文字。
#[test]
fn materials_drop_config_and_node_names() {
    let _serial = serial();
    let root = temp_root("names");
    let data_dir = temp_root("data");
    let mut ctx = context(&data_dir);
    ctx.runtime["config_name"] = json!("我的订阅");
    ctx.runtime["node_name"] = json!("东京 01");
    ctx.checks = json!([{
        "id": "config.current_config",
        "detail": "当前配置：我的订阅，节点：东京 01"
    }]);

    let data = generate("s14", &input(None), &ctx, &root).unwrap();
    let materials = data["materials"].to_string();
    assert!(!materials.contains("我的订阅"), "{materials}");
    assert!(!materials.contains("东京 01"), "{materials}");
    assert!(materials.contains("配置 1"), "{materials}");
    assert!(materials.contains("节点 1"), "{materials}");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 同一会话并发两次生成：只有一个目录、一个 report_id。
#[test]
fn concurrent_generations_share_one_directory() {
    let _serial = serial();
    let root = temp_root("concurrent");
    let data_dir = temp_root("data");
    let ctx = std::sync::Arc::new(context(&data_dir));
    let results: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                let ctx = std::sync::Arc::clone(&ctx);
                scope.spawn(move || generate("s15", &input(None), &ctx, &root).unwrap())
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert_eq!(results[0]["report_id"], results[1]["report_id"]);
    let dirs = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .count();
    assert_eq!(dirs, 1, "并发时不能各建一个目录");
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data_dir);
}

/// 暂存目录即使已经写了 `.report-id`，`lookup` 也不能认。
#[test]
fn lookup_ignores_staging_directories() {
    let _serial = serial();
    let root = temp_root("tmpdir");
    let staging = root.join(".tmp-deadbeef");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join(".report-id"), "rpt-staging").unwrap();
    reset_registry_for_test();
    assert!(lookup("rpt-staging", &root).is_none());
    let _ = fs::remove_dir_all(&root);
}

/// 多字节 home 长度落在字符中间时不能 panic。
#[test]
fn fold_home_is_safe_on_multibyte_boundaries() {
    // `/Users/alice` 是 12 字节；`/Users/汉` 是 10 字节，`/Users/汉字` 的第 12 字节
    // 正好落在「字」的中间。
    assert_eq!(fold_home_with("/Users/汉字", "/Users/alice"), None);
    assert_eq!(fold_home_with("~/Desktop/x", "/Users/alice"), None);
    assert_eq!(fold_home_with("2026-11-12-1530", "/Users/alice"), None);
}

/// 家目录折叠共用一个实现：Unix / Windows、大小写、路径边界。
#[test]
fn fold_home_handles_both_platforms_and_boundaries() {
    assert_eq!(
        fold_home_with("/Users/alice/Desktop/Veyl 问题报告/x", "/Users/alice").as_deref(),
        Some("~/Desktop/Veyl 问题报告/x")
    );
    assert_eq!(
        fold_home_with("C:\\Users\\Alice\\Desktop\\x", "C:\\Users\\alice").as_deref(),
        Some("~\\Desktop\\x")
    );
    assert_eq!(fold_home_with("/Users/alice2/x", "/Users/alice"), None);
    assert_eq!(fold_home_with("/Volumes/Data/x", "/Users/alice"), None);
}

/// 模型可见日志合计 ≤400 行；超了优先保留 runtime 与 sing-box，行号同步修正。
#[test]
fn materials_never_exceed_400_lines_and_keep_the_priority_logs() {
    let _serial = serial();
    let lines = |tag: &str| json!(vec![tag.to_string(); 300]);
    let mut logs = vec![
        json!({ "name": "runtime-1.14.4.log", "start_line": 1, "lines": lines("r"), "total_lines": 300 }),
        json!({ "name": "sing-box.log", "start_line": 1, "lines": lines("s"), "total_lines": 300 }),
        json!({ "name": "app-2026-11-12.log", "start_line": 1, "lines": lines("a"), "total_lines": 300 }),
        json!({ "name": "helper.log", "start_line": 1, "lines": lines("h"), "total_lines": 300 }),
    ];
    cap_material_lines(&mut logs);

    let total: usize = logs
        .iter()
        .map(|entry| entry["lines"].as_array().unwrap().len())
        .sum();
    assert!(total <= 400, "合计超过 400 行：{total}");
    for name in ["runtime-1.14.4.log", "sing-box.log"] {
        let entry = logs.iter().find(|entry| entry["name"] == name).unwrap();
        assert_eq!(entry["lines"].as_array().unwrap().len(), 200, "{name}");
        assert_eq!(entry["start_line"], 101, "{name} 的行号要跟着截断");
    }
    assert_eq!(logs[2]["lines"].as_array().unwrap().len(), 0);
}

#[test]
fn mail_body_fits_after_encoding_and_keeps_the_legend() {
    let long = format!(
        "# 问题报告\n\n> 本报告由 Veyl 与用户配置的模型生成，可能不准确。\n> 报告中的 `***` 表示已打码（域名子域、节点地址、公网 IP 等）。\n> 报告文件只保存在本机；是否发送由你决定。\n\n## 现象\n{}\n\n## 环境\n- 应用版本：0.1.0\n{}\n\n## 时间线\n{}\n\n## 可疑点\n{}\n\n## 下一步建议\n1. 换节点\n2. 重连\n3. 看日志",
        "现象描述".repeat(400),
        "环境行".repeat(400),
        "15:00:01 事件".repeat(300),
        "1. 可疑点\n证据：日志/x.log:1\n证据：日志/x.log:2\n".repeat(300)
    );
    let body = mail_body(&long);
    assert!(
        encoded_len(&body) <= MAILTO_BODY_LIMIT_BYTES,
        "编码后 {} 字节",
        encoded_len(&body)
    );
    // 图例与披露句永不删。
    assert!(body.contains("`***` 表示已打码"), "{body}");
    assert!(body.contains("只保存在本机"), "{body}");
    assert!(body.contains("现场.json"), "{body}");
    assert!(body.contains("日志/"), "{body}");
    assert!(body.contains("正文已截断"), "{body}");
}

# Veyl

用对话操作 VPN 的桌面客户端。

- 运行时：官方 sing-box 发行版，独立进程，Clash API 控制
- 应用：Tauri v2 + Rust + TypeScript
- 文档：`docs/requirements.md`、`docs/architecture.md`、`docs/contracts/`

## 安全说明

API Key 与目录服务 token 存在本地加密文件（机器绑定，拷到别的机器解不开），但这只防「文件被拿走」，不防以同一用户身份运行的恶意程序。真正的防护手段是使用可随时吊销的 API Key —— 泄露后在服务商控制台删除重建即可。

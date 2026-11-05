# TUN 特权通道

> 日期：2026-11-04
> 依据：`docs/tun-mode.md` §4 定的方向，加上两轮安全评审的结论。
> 实现：`src-tauri/src/tun/protocol.rs`、`tun/xpc.rs`、`tun/privilege.rs`、
> `tun/privilege/smappservice.rs`、`tun/session.rs`、`src/bin/veyl-helper.rs`
>
> **这份文档存在的意义**：控制文件方案被废弃过一次，原因是它本身就是一个提权入口。
> 不把「为什么不行」写清楚，下一个人会想当然地再写一遍。

---

## 1. 为什么不能用控制文件

第一版的做法是：App 写 `~/Library/Application Support/Veyl/tun/control.json`，
root helper 轮询这个文件，按里面的 `binary` 字段起进程。

它的提权路径是三步叠出来的：

1. helper 以 **root** 运行；
2. 它读的控制文件在**当前用户完全可写**的目录里；
3. 文件里的 `binary` 字段决定执行哪个可执行文件。

于是：任何一个以该用户身份运行的进程——恶意软件、别的 App、一段脚本、
浏览器里跑出来的东西——只要往那个目录放一个 0755 文件，再写一条 JSON 指过去，
就拿到了 root。不需要密码、不需要用户点允许。

**加校验救不回来。** 路径规范化、`O_NOFOLLOW`、检查属主、限制在 root 之内，
全部无效——因为「root 之下的这个目录」本身就是攻击者能写的地方。
信任根一旦落在用户可写的位置，上面叠多少校验都是在同一块沙子上盖楼。

结论：**信任根必须来自代码签名**，而不是来自文件系统权限。

---

## 2. 结构

```
Veyl.app（Developer ID 签名 + hardened runtime）
  └── XPC 客户端 ──┐
                   │ Mach service: com.veyl.helper
/Applications/Veyl.app/Contents/Library/LaunchDaemons/com.veyl.helper.plist
                   │ launchd 以 root 启动
                   ▼
             veyl-helper（root）
                   ├── 信任根：/Library/Application Support/Veyl（属主 root，用户建不了东西在里面）
                   │      ├── runtime/<完整 sha256>/sing-box   0755
                   │      ├── rules/<tag>.srs                  只读
                   │      └── tun/{active.json,sing-box.pid}   0600
                   └── 来源：  Contents/Resources/runtime/sing-box（随包、同签名，仅作复制源）

helper 与 sing-box 的**日志**不在信任根里：写到连接用户家目录的
`~/.veyl/helper-logs/{helper,sing-box}.log`（0755 目录、0644 文件），
root 逐级 `openat(O_DIRECTORY|O_NOFOLLOW)` 并校验属主，失败只打 stderr。
```

**信任根不是 `<data>`。** 第一版把它放在
`~/.veyl`——那是当前用户完全可写、可整体删除重建的目录，
于是 helper 碰到的六个路径（运行时、配置、pid、日志、规则）全部连带不可信：
用户往 `runtime/<id>/sing-box` 放一个 0755 文件，root 就会执行它。
和 §1 是同一类错误，只是换了个入口。

现在是系统级目录：实测 `/Library/Application Support` 是 `root:admin 0755`，
没有 group 写位，普通用户与管理员都建不了东西在里面，**只有 root 能建 `Veyl/`**，
不存在「攻击者抢先建目录」的竞态。

**每次使用前逐级校验**，不是建的时候看一眼。`tun/trust.rs::verify_chain`
从 `/` 一路 lstat 到目标：真实目录、非软链、uid == 0、无 group/other 写位。
任何一级不合规就退出，**不降级**；`Veyl/` 已存在但属主不对时直接失败，
**不去 chown「修好」它**——那等于把别人建的东西合法化。

---

## 3. 注册

plist 放在 `Contents/Library/LaunchDaemons/com.veyl.helper.plist`：

```xml
<key>Label</key>          <string>com.veyl.helper</string>
<key>BundleProgram</key>  <string>Contents/MacOS/veyl-helper</string>
<key>MachServices</key>   <dict><key>com.veyl.helper</key><true/></dict>
<key>RunAtLoad</key>      <true/>
<key>KeepAlive</key>      <dict><key>SuccessfulExit</key><false/></dict>
```

App 侧 `SMAppService.daemon(plistName:).register()`，用户在
「系统设置 › 登录项与扩展」批准一次，之后由 launchd 守护。

**`.notFound` 不是「包里没有 plist」。** 它的语义是「系统注册库里还没有这个
服务」：注册前、以及未签名未打包的 build 上，`status()` 都会返回它。旧实现
把它当成「安装包里没有找到后台助手」直接短路，`register()` 从未被调用，
用户也就永远看不到授权提示。现在 `.notFound` 与 `.notRegistered` 走同一条
注册分支——都去调 `register()`，注册后**重新读一次状态**：

| 注册后的情况 | 结果 |
| --- | --- |
| `register()` 抛错 | `helper_install_failed`，detail 是系统的 `localizedDescription` |
| `enabled` | 成功 |
| `requires_approval` | 打开「登录项与扩展」，返回 `tun_denied` |
| 其它（状态没变） | `helper_install_failed`，detail 带上注册后的状态 |

**App 必须在 `/Applications`**，否则 LaunchDaemon 的开机自举不保证。
这条要**告诉用户**，不能静默失败成一个 `helper_missing` 让他去猜——
`tun::privilege::app_location_hint()` 会把这句附在错误信息里。

---

## 4. 对端验签

服务端在连接建立时由 libxpc 校验，**不读消息、不看 pid**：

```
xpc_connection_set_peer_code_signing_requirement(connection, requirement)
```

requirement 的确切内容：

```
anchor apple generic
and identifier "io.github.aiwithblockchain.veyl"
and certificate leaf[subject.OU] = "2XYK8RBB6M"
```

（实际是一行；上面为可读性折行。）

**这个字符串不能手写。** 第一版在 helper 里硬编码成 `com.veyl.app`，
和 `tauri.conf.json` 里的真值不一致，结果是**所有连接被拒且编译期无感**——
只有用户装好签名包点连接的那一刻才会失败。

现在的做法：`src-tauri/build.rs` 从 `tauri.conf.json` 的 `identifier` 读出真值，
用 `cargo:rustc-env` 编成 `VEYL_BUNDLE_IDENTIFIER`；`protocol::app_requirement()` 用它拼。
测试 `the_requirement_uses_the_real_bundle_identifier` 直接读配置文件比对，
并断言旧值不再出现。**同源由构建脚本保证，不由人眼保证。**

为什么不用「取 pid 再 `SecCodeCheckValidity`」：那两步之间有窗口，
而且要求被验证方自己提供 pid 作为依据。`set_peer_code_signing_requirement`
在连接建立时就定了性质，窗口不存在。

**失败方向是拒绝**：校验不过，请求被丢掉，不会有任何降级路径。

---

## 5. 请求里不能出现路径

XPC 请求只有两样东西：

| 字段 | 内容 |
|---|---|
| `config` | sing-box 配置的 **JSON 内容**（上限 512 KB） |
| `runtime` | 运行时标识（当前实现，见 §8） |

**没有任何路径字段。** 运行时从 helper 自己的 bundle 取，配置由 helper 改写后
写到自己的目录，日志与 pid 也都在自己的目录。攻击者能写的地方，一个都进不了执行路径。

`config` 是内容不是路径，这一点很关键：如果传路径，helper 就要读一个用户可写的文件，
又回到 §1 的问题。

---

## 6. 配置 allowlist

验签证明「请求来自我们签名的 App」，**但挡不住 App 内部被攻破**——
webview 里跑的 JS 没被验过，Tauri 的命令通道也不认证调用方。
所以配置校验不是可选项，是最后一道防线。

`protocol::enforce_allowlist()` 逐段检查，**多余键一律拒绝**，不是忽略
（忽略等于让它静静影响 root 进程的行为）。段落与键：

| 段落 | 放行的键 |
|---|---|
| 顶层 | `log` `dns` `inbounds` `outbounds` `route` `experimental` |
| `log` | `level` `timestamp` `disabled` `output`\* |
| `inbounds[]` | `type` `tag` `address` `auto_route` `route_exclude_address` `mtu` `stack` `strict_route` |
| `outbounds[]` | `type` `tag` `server` `server_port` `method` `password` `uuid` `flow` `tls` `outbounds` `default` `multiplex` |
| `outbounds[].tls` | `enabled` `server_name` `insecure` `utls` `reality` |
| `dns` | `servers` `rules` `final` `strategy` `independent_cache` |
| `dns.servers[]` | `type` `tag` `server` `detour` |
| `dns.rules[]` | `rule_set` `server` `action` `domain` `domain_suffix` `domain_keyword` |
| `route` | `rules` `rule_set` `final` `auto_detect_interface` `default_domain_resolver` |
| `route.rule_set[]` | `tag` `type` `format` `path`\* |
| `route.rules[]` | `action` `outbound` `protocol` `sniffer` `timeout` `rule_set` `ip_is_private` `domain` `domain_suffix` `domain_keyword` `ip_cidr` `port` |
| `experimental` | `clash_api` |

\* 两个例外，**放行进来是为了改写/删除，不是采信**：

- `log.output` —— 决定 root 往哪写文件。helper 直接删掉它，用自己的日志路径。
- `route.rule_set[].path` —— 决定 root 读哪个文件。helper 丢弃请求值，
  按 `tag` 从自己的规则目录取；取不到就报 `rule_set_missing`，不猜。

另外三条硬规则：

1. **只接受 `type: "tun"` 的入站**。出现 `mixed` / `http` / `socks` 一律拒绝——
   否则等于在用户不知情时多开一个监听。
2. **规则集不许远程引用**。`url` / `http_client` / `download_detour` 直接拒绝：
   root 去拉一个请求方给的 URL，是以 root 身份做的 SSRF。
3. **Clash API 只能回环**，端口由 helper 分配、secret 由 helper 生成，回包里告诉 App。
   `0.0.0.0` 之类的值会被覆盖。

出站与 DNS 服务器的**类型**也走枚举白名单，不认识就不放行。

---

## 7. 崩溃与孤儿进程

### 产品决定：App 崩溃时保持连接

TUN 的 sing-box 是 **helper** 的子进程，不是 App 的子进程。
所以 App 崩溃不影响已经建立的隧道——正在用的网络不会被打断。
App 重启后，`TunSession` 首次查询状态会向 helper 问一次并把 pid 接手过来
（之后走内存缓存，不打 XPC）。

### helper 重启时的孤儿

helper 自己崩溃重启时，上次起的 sing-box 可能还活着——
那是一个带着活跃隧道、没人管的 root 进程。

helper 启动时先扫自己的 tun 目录：

1. 读 pid 文件，里面记了三行：`pid` / 启动时间 / 可执行文件路径。
2. **三重核对**：`proc_pidpath` 得到的路径与记录一致、`ps -o lstart=` 得到的
   启动时间与记录一致、pid 确实存活。
3. 全中才 TERM，5 秒不退再 KILL。

**不能只按 pid 杀**——pid 会被复用，可能杀掉一个完全无关的进程。

然后删掉残留的 `active.json` 与 pid 文件。此刻没有任何连接，
目录里的活动配置一定是上次崩溃的产物，而它含节点密码。

### 配置的生命周期

`active.json` 只在连接期间存在：停止、启动失败、helper 收到 SIGTERM、崩溃后重启，
四条路径都会删。权限 0600，`O_NOFOLLOW` 打开。

---

## 8. 运行时与已知限制

**运行时随 App bundle 分发**（`Contents/Resources/runtime/sing-box`），
helper 只执行这一份。放用户目录、从网上下载的二进制以 root 执行，
和 §1 是同一类问题——这条是 `docs/user-flows.md` §1.3 的要求，不是新增约束。

**请求里没有运行时标识。** helper 只认由 `build.rs` 编译进来的**完整 256 位 sha256**，
路径自己拼：`<root>/runtime/<完整哈希>/sing-box`。每次 start 都重新校验
（普通文件、非软链、uid 0、0755、完整哈希），不是只在复制时校验一次。

64 位前缀匹配已被取消——前缀相等不等于内容相等。

`build-dmg.sh` 在缺少 `resources/runtime/sing-box` 时**直接失败**，不再只警告。

### 8.1 信任链，以及它成立的前提

| 环节 | 靠什么 | 挡住什么 |
|---|---|---|
| App 与 helper 未被替换 | Developer ID 签名 + 公证 | 换包、换 helper |
| 请求来自我们的 App | XPC `set_peer_code_signing_requirement` | 别的进程冒充 |
| 运行时内容 | 完整 256 位 sha256 编译进 helper，每次 start 复核 | 构建后替换运行时 |
| 规则内容 | 归档哈希编译进 helper，再逐项按清单校验 | 构建后替换归档 |
| 构建产物落点 | `build-dmg.sh` 在签名前的断言 | Tauri 资源路径猜错 |

把归档哈希编进 helper 是一个**有效的构建期绑定**：哈希随 helper 一起被签名，
构建完成之后再把包里的归档换掉会被发现。

但它**不是「来源可信」的证明**——哈希是从归档本身算出来的，
构建期就被替换的话它验不出来。

**整套防线有一个前提，目前没有任何人验证过**：
SMAppService 启动 helper 时，是否对 helper 本身做代码签名校验。
如果不做，helper 被替换之后，上面这些检查全部在一个已经被换掉的程序里执行，
等于不存在。这一条必须在真机签名包上确认，是合入前必须回答的问题。

---

其余已知限制：

| 限制 | 说明 |
|---|---|
| 多用户 | 信任根是系统级的，`/Library/Application Support/Veyl` 全机器共用；TUN 同时只允许一条连接 |
| TUN 不进 `RuntimeManager` | 没有自动重连与看门狗；`runtime_status` 返回精简快照 |
| 后台升级运行时 | 对 TUN 不生效，要等下次 App 更新（见 `docs/upgrade.md` §4.1） |
| 规则数据 | helper 从 bundle 的 `veyl-rules-*.tar.zst` 解到 `<root>/rules/current/`。归档的 sha256 编译进 helper，逐项再按清单哈希校验 |
| 日志 | helper 的 sing-box 日志超过 5 MiB 轮转一次、保留上一份，稳态上限约 10 MiB（`5 MiB + 5 MiB`）。没有更细的按天切分 |

---

## 9. Entitlement

| 项 | 需要吗 |
|---|---|
| XPC 连接全局 Mach service | 不需要（Developer ID、非沙盒） |
| helper 守护进程 | 不需要 |
| Network Extension | 不需要（不用 `NEPacketTunnelProvider`） |
| hardened runtime + 公证 | **必须**，否则验签没有意义 |
| `com.apple.security.temporary-exception.mach-lookup.global-name` | 现在不需要；将来开沙盒才要 |

---

## 10. 尚未真机验证

以下三条需要一个签名包才能验，目前**只到编译通过**：

1. `MachServices` 的名字是否要带 Team ID 前缀才会被 `SMAppService` 正确注册。
2. `BundleProgram` 与 `MachServices` 并存是否被 launchd 接受。
3. `xpc_connection_set_peer_code_signing_requirement` 在未公证的本地签名包上的行为。

**已确认（2026-11-05 真机）：注册前 `status()` 返回 `.notFound` 属预期。**
它只说明系统注册库里还没有这个服务，不能拿来推断「包里没有 plist」——
见 §3 的分支表。启动日志里首次运行显示 `TUN helper=not_found` 同理，是
还没注册，不是装不上。

验证方式：`bash scripts/packaging/build-dmg.sh --skip-notarize` 出包后安装，
观察连接是否被接受、拒绝时日志是否给出明确原因。

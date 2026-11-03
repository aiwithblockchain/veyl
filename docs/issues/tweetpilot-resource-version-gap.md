# TweetPilot：预置资源版本号漏 bump 会导致存量用户永久停在旧版

> 核实日期：2026-11-03
> 核实方式：直接读 `/Users/wesley/ai/TweetPilot` 当前代码
> 结论：**问题仍然存在，没有任何构建期或测试期防线。**

---

## 1. 现状

| 环节 | 位置 | 现状 |
|---|---|---|
| 版本号 | `resources/tweetpilot-home/resource_versions.json` | 手写的整数：`prompts/zh: 39`、`prompts/en: 41`、`clawbot: 25` |
| 覆盖判断 | `src-tauri/src/services/resource_installer.rs:243-267` | `bundled > installed` 才强制覆盖整目录；相等不动 |
| 版本 bump 脚本 | `scripts/bump-version.sh` | **只改 `tauri.conf.json` / `Cargo.toml` / `package.json` 三处 APP 版本号，不碰 `resource_versions.json`** |
| 构建钩子 | `package.json` 的 `build` / `tauri:build` | **没有任何资源校验步骤** |
| 测试 | `rate_limiter.rs` 单测 | 断言「代码阈值 == 文档阈值」，**不覆盖版本号 bump** |

## 2. 他们自己的文档已记录此事

- `docs/update-helper-requirements.md:27`：v0.9.13-r1 事故记录
- `docs/design/account_localbridge/微信视频号接入开发计划.md:559`：
  > 「现有单测**不覆盖** `resource_versions.json` 的 bump（测试注释里明确写了这一点）。漏 bump 不会变红，但老用户永远拿不到新文档——必须人工检查。」

也就是说：**他们知道，并且把「人工检查」当成了流程的一部分。**

## 3. 事故的完整因果链

v0.9.13-r1 那次：

```
限流文档新增抖音章节（dy.comments 等 15 个端点）
        ↓
改了 resources/.../prompts/{zh,en}/api-rate-limits.md
        ↓
忘了 bump resource_versions.json 的 prompts/zh、prompts/en
        ↓
安装器判断 bundled(39) > installed(39) 为假 → 不覆盖
        ↓
存量用户机器上的 ~/.tweetpilot/prompts/ 永久停留在旧版
        ↓
评论区拓客模板指示 AI 去 cat api-rate-limits.md 读限流表
        ↓
读不到抖音行 → 任务创建失败
```

**新用户不受影响**（全新安装直接装 bundeded 副本），所以本地开发和测试都发现不了。受影响的只有升级上来的老用户，而且没有任何报错。

## 4. 为什么现有测试抓不到

单测断言的是「代码里的阈值 == md 文档里的阈值」，它读的是**仓库里的 md 文件**。

而故障发生在「**用户机器上已安装的副本**」——那个副本只在 `bundled > installed` 时才会被覆盖。

测试跑在构建机上，构建机永远直接用 bundled 资源，**永远不会走到 `installed` 落后于 `bundled` 的那个分支**。所以测试再严也抓不到这个问题。

## 5. 建议的修法

### 5.1 根治：让安装器按内容判断，而不是按版本号

现在的问题本质是：**版本号是「人写的一行数字」，与它描述的文件内容之间没有任何程序性关联。**

- 改文件不会改数字
- 改数字也不会改文件
- 两者只能靠人记住

改法：`resource_versions.json` 的每个条目除了 `version`，再记一个 `sha256`（对目录内所有文件按相对路径排序拼接后取哈希）。安装器判断是否覆盖时，**比对 hash，而不是比对数字**。

效果：即使漏 bump，安装器也能发现内容变了，自动覆盖。

版本号从此降级为**展示信息与日志用**，不再是控制开关。这是最彻底的修法。

### 5.2 兜底：构建期校验

构建时重算目录 hash，与 manifest 不等就**让构建失败**，并直接打印修法：

```
[resource-check] prompts/zh 内容已变更
  manifest version: 39 → 需要 bump 到 40
  请运行：npm run bump:resources prompts/zh
```

这挡住的是「本地构建就发版」的场景，5.1 挡住的是「发版了但用户没更新到」的场景。**两个都要。**

### 5.3 顺手：把 bump 挪进脚本

`scripts/bump-version.sh` 加一步：检测资源目录的变更，自动 bump 对应条目。注意 `bump-version.ps1` 要同步改，两平台行为必须一致。

## 6. 一个更普遍的问题

TweetPilot 的 `include_str!` 那批提示词（`task_ai_executor.rs:148`、`comment_reply_executor.rs:216`）**编进二进制**，不走资源覆盖，所以它们没有这个问题——重新构建就生效。

但这也意味着项目里存在**两套提示词分发机制**：

| 机制 | 生效方式 | 漏改的后果 |
|---|---|---|
| `include_str!` 编进二进制 | 重新构建 | 无（构建即生效） |
| 资源目录 + 版本号覆盖 | 要 bump 版本号 | 存量用户永久停在旧版 |

同一个项目里两种机制并存，本身就是一个陷阱：改提示词的人未必知道自己用的是哪一种。

**建议统一到一种**，或者至少在两处入口都留显著注释说明「这里改完还要做什么」。

---

## 7. 落地时绕不过去的三件事

上面的修法方向对，但直接照着做会踩三个坑。这三条必须提前定，写完就改不了。

### 7.1 存量机器没有 hash，第一次怎么判断

现在所有用户的 `~/.tweetpilot/resource_versions.json` 里只有整数，没有 `sha256`。

迁移规则要写死：

> **已安装 manifest 里没有 `sha256` 字段的条目，一律视为落后，强制覆盖一次。**

如果不这么定，就会出现「新代码读不到 hash，当成相等，于是又跳过一次覆盖」——那这次修复对存量用户完全无效，等于白改。

这一条不写清楚，改完之后还得再出一次同样的事故。

### 7.2 目录 hash 的算法必须一次定死

`prompts/zh` 是一个目录，hash 要覆盖目录内所有文件。算法必须固定并写进注释：

```
1. 递归列出目录内所有文件的相对路径
2. 按字节序排序（不是按系统默认顺序，macOS 和 Linux 不一样）
3. 对每个文件，hash 输入 "相对路径\0文件内容\0"，依次累加
4. 最终取 sha256
```

任何一环变了，所有用户的 hash 全变，会触发一次全量重下。**这条一旦上线就不能再动**，所以第一次定的时候就要想清楚，并且在代码里写死注释。

### 7.3 manifest 格式变更是持久化格式变更

`{"prompts/zh": 39}` → `{"prompts/zh": {"version": 39, "sha256": "..."}}` 属于他们 `AGENTS.md:228` 明确要求登记的那类变更。

需要：

- 新代码**同时能读新旧两种格式**，发一个过渡版本
- 过渡版本的安装器把旧格式条目自动升级成新格式（此时补上 hash 并强制覆盖一次）
- 迁移登记进 `docs/update-helper-requirements.md`

如果直接切成新格式，老版本的 App 读到对象会解析失败。

### 7.4 顺带别漏了 Windows

`scripts/bump-version.ps1` 与 `bump-version.sh` 是两份独立实现。只改 shell 那份，Windows 发版照样漏。

---

## 8. 最小改动预算

如果只想做「不改格式、不写迁移」的最小版本，那就只能选 §5.3（把 bump 挪进脚本）：

| 改哪个文件 | 加什么 |
|---|---|
| `scripts/bump-version.sh` | 比对 `resources/tweetpilot-home/` 的 git diff，有变更就 bump 对应条目 |
| `scripts/bump-version.ps1` | 同上 |
| 发布流程（`release.sh`） | 调用上面的脚本，**并且校验工作区干净**——bump 完还没提交就发版是另一种漏 |

代价：只在发版脚本里生效，本地 `npm run tauri:build` 直接出包仍然拦不住。

**能挡住大部分事故，但挡不住「绕过发版脚本」的情况。** 建议至少做这个，有余力再做 §5.1。

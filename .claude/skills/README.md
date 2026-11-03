# 第三方参考 skill

这个目录里只有 `veyl-ui` 是**本项目自己写的**，会随仓库提交。

其余子目录都是从公开仓库拷进来的第三方 skill，**不入库**（`.gitignore` 已排除），只在本机可用。
删掉后需要重新拉取，命令见下。

## 当前使用的

| 目录 | 来源 | 许可 | 用途 |
|---|---|---|---|
| `frontend-design` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Apache 2.0 | 设计方法与审美判断 |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT | 可检索的设计知识库（风格、配色、UX 规则） |
| `product-designer` | [borghei/Claude-Skills](https://github.com/borghei/Claude-Skills) `bundles/product-skills` | MIT + Commons Clause | 信息架构、UI 基础、可用性 |
| `design-system-lead` | 同上 | MIT + Commons Clause | token 架构、组件库治理 |
| `product-manager-toolkit` | 同上 | MIT + Commons Clause | RICE、PRD、发现框架 |

## 重新安装

```bash
# 前两个
git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git /tmp/uupm
cp -R /tmp/uupm/.claude/skills/ui-ux-pro-max .claude/skills/

# borghei 的三个
git clone --depth 1 https://github.com/borghei/Claude-Skills.git /tmp/bsk
for d in product-designer design-system-lead product-manager-toolkit; do
  mkdir -p ".claude/skills/$d"
  cp "/tmp/bsk/bundles/product-skills/skills/$d/SKILL.md" ".claude/skills/$d/SKILL.md"
done
```

注意：git 不走 macOS 系统代理。在中国网络环境下克隆前要先设代理：

```bash
PORT=$(scutil --proxy | awk '/HTTPSPort/ {print $3}')
git -c http.proxy=http://127.0.0.1:$PORT -c https.proxy=http://127.0.0.1:$PORT clone --depth 1 <url>
```

## 约定

- 第三方 skill 只作为参考，**不修改内容**。需要改的判断写进 `veyl-ui`。
- borghei 的 skill 文末提到 `scripts/*.py`，这些脚本没有随附，不要执行。
- `ui-ux-pro-max` 带一个检索脚本（`scripts/search.py`），只做本地 CSV 查表，无外部命令执行。

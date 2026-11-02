#!/usr/bin/env bash
# 用法：
#   bash scripts/check-secrets.sh              # 扫描工作区（已跟踪 + 未跟踪且未被忽略的文件）
#   bash scripts/check-secrets.sh --staged     # 只扫暂存区（pre-commit 钩子用）
#   bash scripts/check-secrets.sh --install-hook
#   bash scripts/check-secrets.sh --help
#
# 规则见 docs/build-and-release.md §5.3。命中即 exit 1，列出文件与行号。
# 只读：不联网、不上传、不修改任何文件（--install-hook 除外，它只写 .git/hooks/pre-commit）。
#
# 退出码：0 干净 / 1 发现疑似凭据 / 2 用法或环境错误
#
# 误报处理：在命中那一行末尾写 `check-secrets:allow`，并在同一行说明原因：
#   sk-this-is-a-documentation-example  # check-secrets:allow 文档示例
# 默认拒绝，只有显式标注才放过。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

# --- 规则 ---

# 文件名规则
NAME_PATTERNS='*.key|*.p12|*.pfx|*.pem|*.cer|*.mobileprovision|*.keystore|notary-profile*|.env*'

# 内容规则。PEM 头只认行首或紧随引号的形式——真实的密钥块一定在行首，
# 这样文档里被引号或反引号包住的示例不会被误判。
# 证书那条用字符串拼接，避免脚本把自己的正则字面量扫出来。
CERT_BEGIN="-----BEGIN CE""RTIFICATE-----"
CONTENT_PATTERNS="(^|\")-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|(^|\")${CERT_BEGIN}|\\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\\b|sk-[A-Za-z0-9_-]{20,}"

ALLOW_MARKER="check-secrets:allow"

# --- 参数 ---

MODE="workspace"
case "${1:-}" in
  "")              MODE="workspace" ;;
  "--staged")      MODE="staged" ;;
  "--install-hook") MODE="install-hook" ;;
  "-h"|"--help")   sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数：$1（可用：--staged / --install-hook / --help）" >&2; exit 2 ;;
esac

# --- 安装钩子 ---

if [ "$MODE" = "install-hook" ]; then
  command -v git >/dev/null 2>&1 || { echo "缺 git" >&2; exit 2; }
  HOOK_DIR="$(git rev-parse --git-path hooks 2>/dev/null)" || { echo "不在 git 仓库里" >&2; exit 2; }
  HOOK="$HOOK_DIR/pre-commit"

  if [ -f "$HOOK" ] && ! grep -q "check-secrets.sh" "$HOOK" 2>/dev/null; then
    cat >&2 <<EOF
已存在 pre-commit 钩子，未覆盖：$HOOK

请手工把下面这行加到该钩子开头，或先备份再删除它：
    bash "\$(git rev-parse --show-toplevel)/scripts/check-secrets.sh" --staged
EOF
    exit 2
  fi

  mkdir -p "$HOOK_DIR"
  cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# 由 scripts/check-secrets.sh --install-hook 生成
exec bash "$(git rev-parse --show-toplevel)/scripts/check-secrets.sh" --staged
EOF
  chmod +x "$HOOK"
  echo "已安装 pre-commit 钩子：$HOOK"
  exit 0
fi

# --- 取文件清单 ---

command -v git >/dev/null 2>&1 || { echo "缺 git" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "不在 git 仓库里，无法确定扫描范围" >&2; exit 2; }

FILES=()
SUBMODULES=()
if [ "$MODE" = "staged" ]; then
  while IFS= read -r -d '' f; do FILES+=("$f"); done < <(
    git diff --cached --name-only --diff-filter=ACMR -z
  )
else
  # 第三方 vendored 子模块不扫：里面有上游自己的密钥扫描器测试夹具（假的 PEM 头），
  # 我们改不了也不该改。它们由上游负责，且子模块指针变更需要显式提交。
  if [ -f .gitmodules ]; then
    while IFS= read -r p; do
      [ -n "$p" ] && SUBMODULES+=("$p")
    done < <(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null | awk '{print $2}')
  fi

  PRUNE_EXPR=(-name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .run -o -name out)
  for sm in "${SUBMODULES[@]}"; do
    PRUNE_EXPR+=(-o -path "$ROOT/$sm")
  done

  # 工作区模式走文件系统，不走 git：`*.key` / `.env*` 这类文件在 .gitignore 里，
  # 用 git ls-files --exclude-standard 会把它们藏起来——而它们恰恰是最该被发现的。
  while IFS= read -r -d '' f; do
    FILES+=("${f#"$ROOT"/}")
  done < <(
    find "$ROOT" \( "${PRUNE_EXPR[@]}" \) -prune -o -type f -print0 2>/dev/null
  )

  for sm in "${SUBMODULES[@]}"; do
    [ -e "$ROOT/$sm" ] && printf '跳过子模块：%s（第三方 vendored 代码）\n' "$sm"
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  [ "$MODE" = "staged" ] && echo "暂存区为空，跳过。" || echo "没有可扫描的文件。"
  exit 0
fi

# --- 扫描 ---

HITS=0
print_hit() {
  printf '  %s\n' "$1"
  HITS=$((HITS + 1))
}

is_binary() {
  grep -Iq . "$1" 2>/dev/null || return 0
  return 1
}

for f in "${FILES[@]}"; do
  base="$(basename "$f")"

  # 文件名命中
  # shellcheck disable=SC2254
  case "$base" in
    *.key|*.p12|*.pfx|*.pem|*.cer|*.mobileprovision|*.keystore|notary-profile*|.env*)
      if grep -q "$ALLOW_MARKER" "$f" 2>/dev/null; then :; else
        print_hit "文件名：${f}（匹配 $(printf '%s' "$NAME_PATTERNS")）"
        continue
      fi
      ;;
  esac

  [ -f "$f" ] || continue
  is_binary "$f" && continue

  # 内容命中
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$ALLOW_MARKER"*) continue ;;
    esac
    print_hit "内容：$line"
  done < <(grep -nEI "$CONTENT_PATTERNS" "$f" 2>/dev/null | sed "s|^|$f:|")
done

# --- 结果 ---

if [ "$HITS" -gt 0 ]; then
  cat >&2 <<EOF

发现 $HITS 处疑似凭据，已阻止。这些内容不能进仓库。

处理方式：
  1. 凭据类文件：从工作区删除，改用系统 keychain 或 CI secret；
  2. 误报：在那一行末尾加 \`$ALLOW_MARKER\` 并写明原因；
  3. 已误提交过：光删文件不够，需要轮换凭据并清理历史（报给 PM）。

扫描范围：$([ "$MODE" = "staged" ] && echo "暂存区" || echo "工作区（已跟踪 + 未跟踪）")
EOF
  exit 1
fi

printf '密钥扫描通过（%d 个文件，模式 %d 类）\n' "${#FILES[@]}" 4
exit 0

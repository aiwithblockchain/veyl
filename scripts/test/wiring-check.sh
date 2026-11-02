#!/usr/bin/env bash
# 用法：
#   bash scripts/test/wiring-check.sh            # advisory：有问题只告警，退出码恒为 0
#   bash scripts/test/wiring-check.sh --strict   # 有零引用项时退出 1
#
# 为什么需要这个脚本：能力写了、测试写了、但没人调用它。这类问题单测和契约检查都抓不到，
# 只有在用户点下去发现「没反应」时才暴露。已发生过三次：
#   D-03 set_credentials 无调用方 / D-08 chat_history 前端不调 / D-10 device token 三件套无调用方
#
# 它只检查**手工维护的关键能力清单**，不扫全部 pub fn —— 全扫的噪音会让人直接忽略它。
#
# 维护（Clerk）：
#   - 新增一项能力：往 CAPABILITIES 里加源码里的**实际符号名**。加了就代表承诺它有调用方。
#   - 删掉一项能力：删清单条目；若只是重命名，改成新名字即可（旧名字会报「定义未找到」）。
#   - 切换门禁：`ci.sh` 里现在是 `|| true`（advisory）。观察一段时间、确认没有误报后，
#     改成 `bash scripts/test/wiring-check.sh --strict` 即可纳入硬性门禁。
#   - 误报处理：trait 对象 / 字符串反射 / 宏生成间接调用会被算成零引用。
#     优先加一行注释说明并临时移出清单，不要为此引入解析器。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

STRICT=0
case "${1:-}" in
  --strict) STRICT=1 ;;
  "") ;;
  *) printf '未知参数：%s（可用：--strict）\n' "$1" >&2; exit 2 ;;
esac

# 关键能力清单。加一项代表「这个能力必须有调用方」。
# 命名用源码里的实际符号名，重命名后这里会显式报 GONE，提醒同步更新清单。
CAPABILITIES=(
  apply_credentials
  chat_history
  register_device
  set_token
  get_device_token
  save_deepseek_key
)

# 定义行：`fn NAME(` 或 `fn NAME<`，带可选 pub / async 前缀
is_definition() {
  local line="$1" name="$2"
  printf '%s\n' "$line" | grep -Eq "(^|[^[:alnum:]_])(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+${name}([^[:alnum:]_]|\$)"
}

# 统计某目录下的引用数（排除定义行）
count_refs() {
  local name="$1" dir="$2"; shift 2
  local hits=0 line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    is_definition "$line" "$name" && continue
    hits=$((hits + 1))
  done < <(grep -rn --binary-files=without-match "$@" -e "$name" "$dir" 2>/dev/null)
  printf '%s' "$hits"
}

# 找定义位置（第一处）
find_definition() {
  local name="$1"
  grep -rn --binary-files=without-match -E \
    "(^|[^[:alnum:]_])(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+${name}([^[:alnum:]_]|\$)" \
    src-tauri/src 2>/dev/null | head -1
}

warned=0
checked=0

printf '\n== 接线检查：%d 项关键能力 ==\n' "${#CAPABILITIES[@]}"
printf '%-24s %-22s %s\n' '能力' '引用（rust / ts）' '定义'
printf '%s\n' '---------------------------------------------------------------'

for name in "${CAPABILITIES[@]}"; do
  def="$(find_definition "$name")"
  if [ -z "$def" ]; then
    printf '%-24s %-22s %s\n' "$name" '—' '定义未找到（已改名或删除？）'
    printf '    ⚠ %s 在当前源码里找不到定义，请同步更新本脚本的 CAPABILITIES 清单\n' "$name"
    warned=$((warned + 1))
    continue
  fi

  rust_refs="$(count_refs "$name" src-tauri/src --include='*.rs')"
  ts_refs="$(count_refs "$name" src --include='*.ts' --include='*.tsx')"
  total=$((rust_refs + ts_refs))
  checked=$((checked + 1))

  loc="${def%%:*}:$(printf '%s' "${def#*:}" | cut -d: -f1)"
  if [ "$total" -gt 0 ]; then
    printf '%-24s %-22s %s\n' "$name" "rust=$rust_refs ts=$ts_refs" "$loc"
  else
    printf '%-24s %-22s %s\n' "$name" "rust=0 ts=0" "$loc"
    printf '    ⚠ %s 实现了但没有调用方 —— 用户会看到「功能存在但不生效」\n' "$name"
    warned=$((warned + 1))
  fi
done

printf '%s\n' '---------------------------------------------------------------'
if [ "$warned" -eq 0 ]; then
  printf '✓ %d 项全部有调用方\n\n' "$checked"
  exit 0
fi

printf '⚠ %d 项需要处理（已检查 %d 项）\n' "$warned" "$checked"
printf '  这是 advisory 检查：默认不影响 CI 退出码。确认无误后加 --strict 纳入门禁。\n\n'

[ "$STRICT" -eq 1 ] && exit 1
exit 0

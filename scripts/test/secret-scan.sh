#!/usr/bin/env bash
# secret-scan.sh — AC-S1 提交前敏感信息扫描（发布门禁）
#
# 用法：bash scripts/test/secret-scan.sh
# 退出码：0 干净 / 1 有命中 / 2 自检失败或环境错误
#
# 扫描范围：已跟踪文件 + 暂存区 + 未跟踪文件（新文件最容易漏）。
# 排除：.git/ node_modules/ target/ src-tauri/claurst/、本脚本、验收规则文档自身。
#
# 三条纪律：
#   1. 脚本内不写任何真实值 —— 全部是通用正则；节点地址若需补充，
#      用环境变量 VEYL_DENY_IPS（逗号分隔），绝不写死。
#   2. 命中只输出「文件:行号 + 类型」，绝不打印命中原文 ——
#      否则扫描日志本身就成了泄漏源。
#   3. 先自检：该命中的要命中、该放行的要放行，否则直接 exit 2。
#      没有自检的扫描器永远返回 0，等于没有。
#
# 职责边界：只查内容泄漏（公网 IP / 用户绝对路径 / 节点 id / 凭据指纹）。
# 凭据文件形态（*.key / *.p12 / *.env、私钥块、sk- 令牌）见 scripts/check-secrets.sh。
# 两者分工不同，各自独占 ci.sh 的一步；新规则请加到对应脚本，不要两边都写。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

ALLOW_RE='(secret-scan|check-secrets):allow'

# RFC 5737 / 3849 文档地址、回环、私有、链路本地、组播与保留段。
IP_ALLOW_RE='^(127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)'

PLACEHOLDER_USER_RE='^(x|X|test|user|username|alice|bob|foo|bar|example|demo|me|you|name|<.+>)$'

EXCLUDE_RE='(^|/)(\.git|node_modules|target)/|^src-tauri/claurst/|^scripts/test/secret-scan\.sh$|^docs/acceptance-p1\.md$'

# 值以 < 开头的一律视为占位（如 "<ciphertext>"、"<启动时随机生成>"）。
PASSWORD_RE="(password|passwd|secret|token|api[_-]?key|access[_-]?key)[[:space:]]*[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"'<][^\"']{7,}[\"']"
TOKEN_RE='sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}'
FINGERPRINT_RE="(pw_fp|fingerprint)[[:space:]]*[:=][[:space:]]*[\"']?[0-9a-fA-F]{8,}"
SEEDS_PATH_RE="(/Users|/home|~)[^[:space:]\"']*seeds\\.json"
NODE_ID_RE='seed-[0-9a-f]{16}'
MAC_USER_RE='/Users/[^/[:space:]"'"'"'`]+/'
WIN_USER_RE='[A-Za-z]:\\Users\\[^\\[:space:]"'"'"'`]+\\'
PRIVATE_KEY_RE="(^|[\"'])-----BEGIN [A-Z ]*PRIVATE KEY-----"

hit() { printf '%s:%s: %s\n' "$1" "$2" "$3"; }

# 行末标注 secret-scan:allow / check-secrets:allow 即豁免（一次标注两个扫描器都认）。
allowed() { printf '%s' "$1" | grep -qE "$ALLOW_RE"; }

# 逐行读取 grep -n 的结果；回调拿到 (文件, 行号, 行内容, 附加参数...)，自行判断是否命中。
each_line() {
  local file="$1" pattern="$2" callback="$3"
  shift 3
  local num line
  while IFS=: read -r num line; do
    allowed "$line" && continue
    "$callback" "$file" "$num" "$line" "$@"
  done < <(grep -nE "$pattern" "$file" 2>/dev/null)
}

cb_public_ipv4() {
  local file="$1" num="$2" line="$3"
  if printf '%s\n' "$line" | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -qvE "$IP_ALLOW_RE"; then
    hit "$file" "$num" "公网 IPv4"
  fi
}

cb_public_ipv6() {
  local file="$1" num="$2" line="$3" cand
  for cand in $(printf '%s\n' "$line" | grep -oE '([0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F]{0,4}|[0-9a-fA-F]{0,4}::[0-9a-fA-F:]*[0-9a-fA-F]'); do
    # 太短的不是地址（Rust 的 foo::bar 会撞上来）；必须含数字。
    [ "${#cand}" -ge 8 ] || continue
    printf '%s' "$cand" | grep -qE '[0-9]' || continue
    case "$cand" in
      ::1|::|2001:db8*|fe80:*|ff[0-9a-f][0-9a-f]:*|::ffff:*) continue ;;
    esac
    hit "$file" "$num" "公网 IPv6"
    return 0
  done
}

cb_plain() {
  local file="$1" num="$2" type="$4"
  hit "$file" "$num" "$type"
}

# 测试里常见的假口令：pw-* / test-* / fake-* / dummy-* / *not-real* / *leak-me*。
# 真实种子密码是随机的，不会长这样；这条豁免只放过明显的夹具。
cb_password() {
  local file="$1" num="$2" line="$3" matched val
  # 只取紧跟在关键字后面的那个值，避免抓到同一行其它带引号的字符串。
  matched="$(printf '%s\n' "$line" | grep -oE "$PASSWORD_RE" | head -n1)"
  val="$(printf '%s' "$matched" | grep -oE "[\"'][^\"']*[\"']$" | head -n1 | sed -E "s/^[\"']//; s/[\"']$//")"
  case "$val" in
    pw-*|test-*|fake-*|dummy-*|example-*|*not-real*|*leak-me*|*placeholder*) return 0 ;;
    \$*) return 0 ;;        # $CLASH_SECRET / $(printf ...) 这类变量或命令替换
    *[a-z]*) : ;;           # 含小写字母，继续按真实值判定
    *) return 0 ;;          # 全大写数字下划线：环境变量名风格（RANDOM_SECRET）
  esac
  hit "$file" "$num" "密码或 token"
}

# 形如 seed-aaaaaaaaaaaaaaaa 的重复字符 id 是测试夹具，不是真实节点。
cb_node_id() {
  local file="$1" num="$2" line="$3" id hex
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    hex="${id#seed-}"
    if [ "$(printf '%s' "$hex" | fold -w1 | sort -u | wc -l | tr -d ' ')" = "1" ]; then
      continue
    fi
    hit "$file" "$num" "节点 id"
    return 0
  done < <(printf '%s\n' "$line" | grep -oE "$NODE_ID_RE")
}

cb_seeds_path() {
  local file="$1" num="$2" line="$3" path
  # 文档里写的应用数据目录（用户自己放种子的位置）不算泄漏。
  case "$line" in
    *"Application Support/Veyl/"*seeds.json*) return 0 ;;
  esac
  path="$(printf '%s\n' "$line" | grep -oE "$SEEDS_PATH_RE" | head -n1)"
  [ -n "$path" ] || return 0
  hit "$file" "$num" "种子文件路径"
}

cb_mac_user() {
  local file="$1" num="$2" line="$3" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s' "$name" | grep -qvE "$PLACEHOLDER_USER_RE" && { hit "$file" "$num" "macOS 用户路径"; return 0; }
  done < <(printf '%s\n' "$line" | grep -oE "$MAC_USER_RE" | sed -E 's#^/Users/([^/]+)/.*#\1#')
}

cb_win_user() {
  local file="$1" num="$2" line="$3" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s' "$name" | grep -qvE "$PLACEHOLDER_USER_RE" && { hit "$file" "$num" "Windows 用户路径"; return 0; }
  done < <(printf '%s\n' "$line" | grep -oE "$WIN_USER_RE" | sed -E 's#^[A-Za-z]:\\Users\\([^\\]+)\\.*#\1#')
}

scan_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -Iq . "$file" 2>/dev/null || return 0

  each_line "$file" '([0-9]{1,3}\.){3}[0-9]{1,3}' cb_public_ipv4
  each_line "$file" '([0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F]{0,4}|[0-9a-fA-F]{0,4}::[0-9a-fA-F:]*[0-9a-fA-F]' cb_public_ipv6
  each_line "$file" "$PASSWORD_RE" cb_password
  each_line "$file" "$TOKEN_RE" cb_plain "疑似 token"
  each_line "$file" "$FINGERPRINT_RE" cb_plain "凭据指纹"
  each_line "$file" "$SEEDS_PATH_RE" cb_seeds_path
  each_line "$file" "$NODE_ID_RE" cb_node_id
  each_line "$file" "$MAC_USER_RE" cb_mac_user
  each_line "$file" "$WIN_USER_RE" cb_win_user
  each_line "$file" "$PRIVATE_KEY_RE" cb_plain "私钥块"
}

list_files() {
  { git ls-files
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } 2>/dev/null | sort -u | grep -vE "$EXCLUDE_RE"
}

selftest() {
  local tmp h c
  tmp="$(mktemp -d)" || return 1

  # 应当命中：公网 IP、密码赋值、真实用户名路径、节点 id
  printf '%s\n' \
    'password = "Sup3rSecretValue"' \
    '198.18.0.1' \
    '/Users/realperson/notes.txt' \
    'seed-0123456789abcdef' >"$tmp/hit.txt"

  # 应当放行：RFC 5737 地址、占位用户名、散文里的字段名、裸种子文件名、Rust 路径
  printf '%s\n' \
    '203.0.113.10' \
    '/Users/x/notes.txt' \
    '字段 pw_fp 用于指纹比对' \
    'seeds.json' \
    'runtime::archive::tests' >"$tmp/clean.txt"

  h="$(scan_file "$tmp/hit.txt")"
  c="$(scan_file "$tmp/clean.txt")"
  rm -rf "$tmp"

  [ -n "$h" ] && [ -z "$c" ]
}

if ! selftest; then
  echo "扫描器自检失败：样例未被正确判定，结果不可信。" >&2
  echo "（检查规则是否被改坏；自检不过时不要放行任何提交。）" >&2
  exit 2
fi

FOUND=0
while IFS= read -r file; do
  out="$(scan_file "$file")"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    FOUND=1
  fi
  if [ -n "${VEYL_DENY_IPS:-}" ]; then
    while IFS= read -r ip; do
      [ -n "$ip" ] || continue
      grep -qF -- "$ip" "$file" 2>/dev/null && { printf '%s:%s\n' "$file" "VEYL_DENY_IPS 命中"; FOUND=1; }
    done < <(printf '%s' "$VEYL_DENY_IPS" | tr ',' '\n')
  fi
done < <(list_files)

if [ "$FOUND" -eq 1 ]; then
  echo "" >&2
  echo "发现疑似泄漏，已阻止提交。只显示位置，不显示原文。" >&2
  echo "处理：改掉源码里的真实值；确属示例时在行末加 secret-scan:allow 并写明原因。" >&2
  exit 1
fi

echo "secret-scan：干净（已扫描工作区、暂存区与未跟踪文件）"
exit 0

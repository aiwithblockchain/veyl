#!/usr/bin/env bash
#
# veyl-cli 的 macOS 打包辅助：身份选择、随包产物准备、组装 .app、签名。
#
# 用法（由 dev.sh / release-dmg.sh source）：
#   ROOT=<client/pc 绝对路径> source scripts/lib/tun-macos.sh
#   prepare_tun_artifacts                 # 在 cargo build 之前
#   assemble_tun_bundle <app> <helper>    # 在 tauri build 之后
#   sign_cli_app <app>                    # 最后
#
# 关键顺序：随包 runtime 必须先签好再进 cargo build——build.rs 把它的哈希编进
# 二进制，签名之后再改字节会让哈希对不上，helper 会报 runtime_missing。

CLI_TEAM_ID="${VEYL_TEAM_ID:-2XYK8RBB6M}"
CLI_HELPER_NAME="veyl-cli-helper"
CLI_PLIST_NAME="com.veyl.cli.helper.plist"
CLI_REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
CLI_RESOURCES="$ROOT/src-tauri/resources"
CLI_RUNTIME="$CLI_RESOURCES/runtime/sing-box"

tun_note() { printf '  %s\n' "$*"; }

# 证书主体的 OU 才是 Team；Apple Development 的 CN 括号里是证书 ID。
cli_cert_team() {
  security find-certificate -c "$1" -p 2>/dev/null |
    openssl x509 -noout -subject -nameopt sep_multiline 2>/dev/null |
    awk -F= '/^ *OU=/{ gsub(/^ +| +$/, "", $2); print $2; exit }'
}

# 选一把 Team 对得上的证书；没有就返回空串（后面退回 ad-hoc，并明确警告）。
cli_signing_identity() {
  if [ -n "${VEYL_CLI_SIGN_IDENTITY:-}" ]; then
    printf '%s' "$VEYL_CLI_SIGN_IDENTITY"
    return 0
  fi
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ "$(cli_cert_team "$name")" = "$CLI_TEAM_ID" ]; then
      printf '%s' "$name"
      return 0
    fi
  done < <(security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/^ *[0-9]*) [0-9A-F]\{40\} "\(.*\)"$/\1/p')
  printf ''
}

cli_codesign() {
  local identity="$1" path="$2" stamp="${3:-0}"
  if [ -z "$identity" ] || [ "$identity" = "-" ]; then
    codesign --force --sign - "$path"
    return
  fi
  local extra="--timestamp=none"
  [ "$stamp" = "1" ] && extra="--timestamp"
  # shellcheck disable=SC2086  # extra 只会是一个不含空格的开关
  codesign --force --options runtime $extra --sign "$identity" "$path"
}

cli_file_team() {
  codesign -dv --verbose=4 "$1" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}'
}

# 1) 准备随包 runtime 与规则归档，并用本 Team 签好 runtime。
prepare_tun_artifacts() {
  mkdir -p "$CLI_RESOURCES/runtime" "$CLI_RESOURCES/rules"

  # 仓库根已经拉过就直接复制，避免每次为另一个 APP 再下载一遍 166MB。
  local root_runtime="$CLI_REPO_ROOT/src-tauri/resources/runtime/sing-box"
  local root_rules="$CLI_REPO_ROOT/src-tauri/resources/rules"
  if [ ! -f "$CLI_RUNTIME" ]; then
    if [ -f "$root_runtime" ]; then
      tun_note "复用仓库根已下载的运行时"
      cp "$root_runtime" "$CLI_RUNTIME" || return 1
    else
      tun_note "缺少随包运行时，调用仓库脚本生成…"
      (cd "$CLI_REPO_ROOT" && node scripts/runtime/fetch-runtime.mjs) || return 1
      cp "$root_runtime" "$CLI_RUNTIME" || return 1
    fi
  fi

  if ! compgen -G "$CLI_RESOURCES/rules/veyl-rules-*.tar.zst" >/dev/null; then
    if ! compgen -G "$root_rules/veyl-rules-*.tar.zst" >/dev/null; then
      tun_note "缺少规则归档，调用仓库脚本生成…"
      (cd "$CLI_REPO_ROOT" && node scripts/rules/fetch-rules.mjs) || return 1
    fi
    cp "$root_rules"/veyl-rules-*.tar.zst "$CLI_RESOURCES/rules/" || return 1
    cp "$root_rules"/SOURCE.txt "$CLI_RESOURCES/rules/" 2>/dev/null || true
    cp "$root_rules"/LICENSE-*.txt "$CLI_RESOURCES/rules/" 2>/dev/null || true
  fi

  CLI_SIGN_ID="$(cli_signing_identity)"
  if [ -z "$CLI_SIGN_ID" ]; then
    tun_note "警告：本机没有 Team $CLI_TEAM_ID 的签名证书；TUN 在真机上不可用（界面仍可运行）"
    return 0
  fi

  if [ "$(cli_file_team "$CLI_RUNTIME")" != "$CLI_TEAM_ID" ]; then
    tun_note "签名随包运行时（Team $CLI_TEAM_ID）"
    cli_codesign "$CLI_SIGN_ID" "$CLI_RUNTIME" "${VEYL_SIGN_TIMESTAMP:-0}" || return 1
  fi
  [ "$(cli_file_team "$CLI_RUNTIME")" = "$CLI_TEAM_ID" ] || {
    tun_note "错误：随包运行时的 Team 与 $CLI_TEAM_ID 不一致"
    return 1
  }
}

# 2) 把 helper、LaunchDaemon plist 与 runtime 放进 .app。
assemble_tun_bundle() {
  local app="$1" helper="$2"
  [ -x "$helper" ] || {
    tun_note "错误：找不到 helper 二进制：$helper"
    return 1
  }
  [ -f "$CLI_RESOURCES/launchd/$CLI_PLIST_NAME" ] || {
    tun_note "错误：缺少 LaunchDaemon plist"
    return 1
  }

  mkdir -p "$app/Contents/Library/LaunchDaemons" "$app/Contents/Resources/runtime"
  install -m 755 "$helper" "$app/Contents/MacOS/$CLI_HELPER_NAME" || return 1
  install -m 644 "$CLI_RESOURCES/launchd/$CLI_PLIST_NAME" \
    "$app/Contents/Library/LaunchDaemons/$CLI_PLIST_NAME" || return 1
  install -m 755 "$CLI_RUNTIME" "$app/Contents/Resources/runtime/sing-box" || return 1

  cmp -s "$CLI_RUNTIME" "$app/Contents/Resources/runtime/sing-box" || {
    tun_note "错误：包内 runtime 与源文件字节不一致"
    return 1
  }
  compgen -G "$app/Contents/Resources/resources/rules/veyl-rules-*.tar.zst" >/dev/null || {
    tun_note "错误：包里没有规则归档（检查 tauri.conf.json 的 bundle.resources）"
    return 1
  }
  tun_note "已装入 helper、LaunchDaemon 与随包运行时"
}

# 3) 先签嵌套 Mach-O、再签 .app，不用 --deep（--deep 会重签 runtime、废掉哈希）。
sign_cli_app() {
  local app="$1" stamp="${VEYL_SIGN_TIMESTAMP:-0}"
  local identity="${CLI_SIGN_ID:-}"

  if [ -z "$identity" ]; then
    tun_note "使用 ad-hoc 签名（TUN 在真机上不可用）"
    codesign --force --deep --sign - "$app" || return 1
    return 0
  fi

  local list
  list="$(mktemp "${TMPDIR:-/tmp}/veyl-cli-sign.XXXXXX")"
  find "$app/Contents" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' candidate; do
      [ "$candidate" = "$app/Contents/Resources/runtime/sing-box" ] && continue
      file "$candidate" 2>/dev/null | grep -q 'Mach-O' && printf '%s\n' "$candidate"
    done >"$list"

  while IFS= read -r target; do
    [ -e "$target" ] || continue
    cli_codesign "$identity" "$target" "$stamp" || {
      rm -f "$list"
      return 1
    }
  done <"$list"
  rm -f "$list"

  cli_codesign "$identity" "$app" "$stamp" || return 1
}

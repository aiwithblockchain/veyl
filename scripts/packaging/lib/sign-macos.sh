#!/usr/bin/env bash
#
# 用法：
#   source scripts/packaging/lib/sign-macos.sh
#   bash scripts/packaging/lib/sign-macos.sh --check-env
#
# 由 build-dmg.sh 调用，也可单独执行 --check-env 看凭据是否就位。
#
# 环境变量：
#   VEYL_DEV_ID_APP       Developer ID Application 证书名；缺失时用 ad-hoc 签名（仅本地）
#   VEYL_NOTARY_PROFILE   notarytool store-credentials 里的 profile 名
#
# 打印环境时只输出「是否设置」，绝不输出值。

VEYL_APP_ENTITLEMENTS="${VEYL_APP_ENTITLEMENTS:-}"

signing_identity() {
  if [ -n "${VEYL_DEV_ID_APP:-}" ]; then
    printf '%s' "$VEYL_DEV_ID_APP"
  else
    printf '%s' "-"
  fi
}

has_notary_credentials() {
  [ -n "${VEYL_NOTARY_PROFILE:-}" ]
}

describe_signing_env() {
  local identity_state="未设置（将使用 ad-hoc 签名）"
  local notary_state="未设置"
  [ -n "${VEYL_DEV_ID_APP:-}" ] && identity_state="已设置"
  [ -n "${VEYL_NOTARY_PROFILE:-}" ] && notary_state="已设置"
  printf '  VEYL_DEV_ID_APP      %s\n' "$identity_state"
  printf '  VEYL_NOTARY_PROFILE  %s\n' "$notary_state"
}

_codesign() {
  local identity="$1"
  shift
  if [ "$identity" = "-" ]; then
    codesign --force --sign - "$@"
  else
    if [ -n "$VEYL_APP_ENTITLEMENTS" ] && [ -f "$VEYL_APP_ENTITLEMENTS" ]; then
      codesign --force --options runtime --timestamp \
        --entitlements "$VEYL_APP_ENTITLEMENTS" --sign "$identity" "$@"
    else
      codesign --force --options runtime --timestamp --sign "$identity" "$@"
    fi
  fi
}

# 第一轮：裸 Mach-O 文件（dylib、helper 可执行文件），由内向外。
sign_nested_files() {
  local app="$1" identity="$2" list
  list="$(mktemp "${TMPDIR:-/tmp}/veyl-sign-files.XXXXXX")"

  find "$app/Contents" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' candidate; do
      if file "$candidate" 2>/dev/null | grep -q 'Mach-O'; then
        printf '%s\n' "$candidate"
      fi
    done >"$list"

  awk -F/ '{ print NF "\t" $0 }' "$list" | sort -rn | cut -f2- |
    while IFS= read -r target; do
      [ -e "$target" ] || continue
      printf '  sign file %s\n' "${target#"$app"/}"
      _codesign "$identity" "$target" || exit 1
    done
  local status=$?
  rm -f "$list"
  return "$status"
}

# 第二轮：嵌套 bundle（.framework / .app / .xpc），仍由内向外。
sign_nested_bundles() {
  local app="$1" identity="$2" list
  list="$(mktemp "${TMPDIR:-/tmp}/veyl-sign-bundles.XXXXXX")"

  find "$app/Contents" -mindepth 1 \
    \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.bundle' \) \
    -print >"$list" 2>/dev/null || true

  awk -F/ '{ print NF "\t" $0 }' "$list" | sort -rn | cut -f2- |
    while IFS= read -r target; do
      [ -e "$target" ] || continue
      printf '  sign bundle %s\n' "${target#"$app"/}"
      _codesign "$identity" "$target" || exit 1
    done
  local status=$?
  rm -f "$list"
  return "$status"
}

sign_app() {
  local app="$1"
  local identity
  identity="$(signing_identity)"

  [ -d "$app" ] || {
    printf '错误：找不到 %s\n' "$app" >&2
    return 1
  }

  if [ "$identity" = "-" ]; then
    printf '警告：未设置 VEYL_DEV_ID_APP，使用 ad-hoc 签名（只能在构建机本机运行）\n' >&2
  else
    printf '签名证书：%s\n' "$identity"
  fi

  sign_nested_files "$app" "$identity" || return 1
  sign_nested_bundles "$app" "$identity" || return 1

  printf '  sign app %s\n' "$(basename "$app")"
  _codesign "$identity" --deep "$app"
}

submit_and_wait() {
  local path="$1" output
  output="$(xcrun notarytool submit "$path" \
    --keychain-profile "$VEYL_NOTARY_PROFILE" --wait 2>&1)"
  local status=$?
  printf '%s\n' "$output"
  if [ "$status" -ne 0 ]; then
    return 1
  fi
  printf '%s\n' "$output" | grep -q 'status: Accepted'
}

notarize_app() {
  local app="$1" work zip
  work="$(mktemp -d "${TMPDIR:-/tmp}/veyl-notary.XXXXXX")"
  zip="$work/$(basename "$app").zip"
  printf '公证 %s\n' "$(basename "$app")"
  ditto -c -k --keepParent "$app" "$zip"
  if ! submit_and_wait "$zip"; then
    rm -rf "$work"
    printf '错误：公证未通过\n' >&2
    return 1
  fi
  rm -rf "$work"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
}

notarize_dmg() {
  local dmg="$1"
  printf '公证 %s\n' "$(basename "$dmg")"
  if ! submit_and_wait "$dmg"; then
    printf '错误：DMG 公证未通过\n' >&2
    return 1
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
}

sign_dmg() {
  local dmg="$1"
  local identity
  identity="$(signing_identity)"
  printf '签名 DMG\n'
  _codesign "$identity" "$dmg"
}

verify_app() {
  local app="$1"
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl -a -vv --type exec "$app"
}

verify_dmg() {
  local dmg="$1"
  spctl -a -t open --context context:primary-signature -v "$dmg"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --check-env)
      describe_signing_env
      ;;
    *)
      cat <<'EOF'
用法：
  source scripts/packaging/lib/sign-macos.sh   在脚本里调用
  bash scripts/packaging/lib/sign-macos.sh --check-env
EOF
      ;;
  esac
fi

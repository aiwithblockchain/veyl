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
#   VEYL_SIGN_TIMESTAMP   1（默认）带安全时间戳；0 用于开发证书（timestamp 服务不保证接受）
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
    return
  fi
  # Developer ID 必须带安全时间戳；开发证书不保证被 timestamp 服务接受，
  # 开发脚本用 VEYL_SIGN_TIMESTAMP=0 关掉它。
  # 关闭时必须显式写 --timestamp=none：Developer ID 证书默认会自动请求时间戳，
  # 只省略 --timestamp 仍会去连 Apple（服务不可达时验签报
  # "A timestamp was expected but was not found"）。
  # 用字符串而不是数组：macOS 自带的 bash 3.2 在 `set -u` 下展开空数组会报错。
  local extra="--timestamp"
  if [ "${VEYL_SIGN_TIMESTAMP:-1}" = "0" ]; then
    extra="--timestamp=none"
  fi
  # shellcheck disable=SC2086  # extra 只会是空串或一个不含空格的开关
  if [ -n "$VEYL_APP_ENTITLEMENTS" ] && [ -f "$VEYL_APP_ENTITLEMENTS" ]; then
    codesign --force --options runtime $extra \
      --entitlements "$VEYL_APP_ENTITLEMENTS" --sign "$identity" "$@"
  else
    codesign --force --options runtime $extra --sign "$identity" "$@"
  fi
}

# 构建前签好随包运行时，让 `build.rs` 哈希的是**签名后的字节**。
#
# 签名会改写 Mach-O（插入 CodeDirectory、时间戳），字节一变，编译期算出的
# sha256 就对不上包里的副本，安装时只能回退到下载。所以顺序必须是：
# 先签运行时 → 再 cargo build（哈希写进主程序与 helper）→ 组装 → 签整个包，
# 组装阶段不能再碰这个文件。
prepare_bundled_runtime() {
  local runtime="$1" identity
  identity="$(signing_identity)"
  [ -f "$runtime" ] || return 0
  printf '  签名随包运行时：%s\n' "$(basename "$runtime")"
  _codesign "$identity" "$runtime" || return 1
  assert_signed_runtime "$runtime" "$identity"
}

# 第一轮：裸 Mach-O 文件（dylib、helper 可执行文件），由内向外。
sign_nested_files() {
  local app="$1" identity="$2" list
  app="${app%/}"
  list="$(mktemp "${TMPDIR:-/tmp}/veyl-sign-files.XXXXXX")"

  find "$app/Contents" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' candidate; do
      # 随包运行时已经在构建前签过（见 prepare_bundled_runtime）。这里重签会
      # 改字节，把编译进二进制的哈希变成废值——全新安装就会一直回退到下载。
      if [ "$candidate" = "$app/Contents/Resources/runtime/sing-box" ]; then
        continue
      fi
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

  # 只封 bundle，不加 `--deep`：嵌套代码已经由内向外签完，`--deep` 会让签名工具
  # 再走一遍嵌套项，把构建前签好的运行时的字节改掉。
  printf '  sign app %s\n' "$(basename "$app")"
  _codesign "$identity" "$app" || return 1
  assert_bundled_runtime "$app" "$identity" || return 1
}

# 运行时必须以裸 Mach-O 的文件名作为签名 identifier：helper 的验签要求里写死了
# `identifier "sing-box"`。它还必须真的带着有效签名——签名是在构建前做的，
# 组装阶段不再重签，这里既验 identifier 也验签名。
assert_bundled_runtime() {
  local app="$1" identity="$2"
  assert_signed_runtime "$app/Contents/Resources/runtime/sing-box" "$identity"
}

assert_signed_runtime() {
  local runtime="$1" identity="$2" identifier authority
  [ -f "$runtime" ] || return 0

  if ! codesign --verify --strict "$runtime" >/dev/null 2>&1; then
    printf '错误：随包运行时没有有效签名：%s\n' "$runtime" >&2
    printf '  它必须在构建前由 prepare_bundled_runtime 签好，\n' >&2
    printf '  build.rs 才能把签名后的哈希编进主程序与 helper。\n' >&2
    return 1
  fi

  identifier="$(codesign -d --verbose=4 "$runtime" 2>&1 | sed -n 's/^Identifier=//p' | head -1)"
  if [ "$identity" = "-" ]; then
    # ad-hoc 的 identifier 本来就会被加随机后缀，且这种包 TUN 也用不了。
    if [ "$identifier" = "sing-box" ]; then
      printf '  运行时签名 identifier：%s\n' "$identifier"
    else
      printf '警告：ad-hoc 签名的运行时 identifier 是 %s（这个包上 TUN 不可用）\n' \
        "${identifier:-<空>}" >&2
    fi
    return 0
  fi

  if [ "$identifier" != "sing-box" ]; then
    printf '错误：运行时的签名 identifier 是 "%s"，helper 验签要求 "sing-box"\n' \
      "${identifier:-<空>}" >&2
    return 1
  fi

  authority="$(codesign -d --verbose=4 "$runtime" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
  if [ "$authority" != "$identity" ]; then
    printf '错误：随包运行时由 "%s" 签名，与当前身份 "%s" 不一致\n' \
      "${authority:-<无>}" "$identity" >&2
    printf '  换证书后必须重新构建，否则编译期哈希与包内副本对不上。\n' >&2
    return 1
  fi
  printf '  运行时签名 identifier：%s\n' "$identifier"
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

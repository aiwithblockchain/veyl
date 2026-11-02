#!/usr/bin/env bash
#
# 用法：
#   bash scripts/version/bump-version.sh 0.2.0
#   bash scripts/version/bump-version.sh --build      # 0.1.0 -> 0.1.1
#   bash scripts/version/bump-version.sh --minor      # 0.1.0 -> 0.2.0
#   bash scripts/version/bump-version.sh --major      # 0.1.0 -> 1.0.0
#   bash scripts/version/bump-version.sh --build --dry-run
#
# 同步三处版本号并回读校验：
#   package.json            .version
#   src-tauri/Cargo.toml    [package] version
#   src-tauri/tauri.conf.json  .version
#
# 前置：python3。不修改 Cargo.lock（下次构建时 cargo 会自己更新）。
# --build/--minor/--major 会丢弃预发布后缀，例如 0.1.0-rc.1 -> 0.1.1。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_JSON="$ROOT/package.json"
CARGO_TOML="$ROOT/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：
  bump-version.sh <x.y.z>            设定指定版本
  bump-version.sh --build            修订号 +1
  bump-version.sh --minor            次版本 +1，修订号归零
  bump-version.sh --major            主版本 +1，次版本与修订号归零
  bump-version.sh <flag> --dry-run   只打印，不落盘

同步 package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 并回读校验。
EOF
}

MODE=""
TARGET=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --build) MODE="build" ;;
    --minor) MODE="minor" ;;
    --major) MODE="major" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "未知参数：$arg（见 --help）" ;;
    *)
      if [ -n "$TARGET" ]; then
        die "只能指定一个版本号（已有 $TARGET，又收到 $arg）"
      fi
      TARGET="$arg"
      ;;
  esac
done

if [ -n "$TARGET" ] && [ -n "$MODE" ]; then
  die "--build/--minor/--major 不能和显式版本号同时使用"
fi
if [ -z "$TARGET" ] && [ -z "$MODE" ]; then
  usage >&2
  die "缺少目标版本"
fi

command -v python3 >/dev/null 2>&1 || die "缺少 python3"
for file in "$PKG_JSON" "$CARGO_TOML" "$TAURI_CONF"; do
  [ -f "$file" ] || die "找不到文件：$file"
done

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]
}

read_pkg_version() {
  python3 - "$PKG_JSON" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    print(json.load(fh)["version"])
PY
}

read_cargo_version() {
  python3 - "$CARGO_TOML" <<'PY'
import re, sys
section = None
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped
            continue
        if section == "[package]":
            match = re.match(r'\s*version\s*=\s*"([^"]+)"', line)
            if match:
                print(match.group(1))
                break
PY
}

read_tauri_version() {
  python3 - "$TAURI_CONF" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    print(json.load(fh)["version"])
PY
}

CURRENT="$(read_pkg_version)"
is_semver "$CURRENT" || die "package.json 里的版本 '$CURRENT' 不是 semver"

if [ -n "$TARGET" ]; then
  is_semver "$TARGET" || die "版本 '$TARGET' 不是 semver（要求 x.y.z，可带 -pre/+build）"
  NEW="$TARGET"
else
  IFS=. read -r major minor patch_and_rest <<< "$CURRENT"
  patch="${patch_and_rest%%[-+]*}"
  case "$MODE" in
    build) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  NEW="$major.$minor.$patch"
fi

CARGO_CURRENT="$(read_cargo_version)"
TAURI_CURRENT="$(read_tauri_version)"

printf '当前版本\n'
printf '  package.json              %s\n' "$CURRENT"
printf '  src-tauri/Cargo.toml      %s\n' "${CARGO_CURRENT:-<读取失败>}"
printf '  src-tauri/tauri.conf.json %s\n' "${TAURI_CURRENT:-<读取失败>}"
if [ "$CURRENT" != "$CARGO_CURRENT" ] || [ "$CURRENT" != "$TAURI_CURRENT" ]; then
  printf '警告：三处当前版本不一致，本次会一起覆盖为 %s\n' "$NEW" >&2
fi

printf '\n将写入 %s：\n' "$NEW"
printf '  package.json              %s -> %s\n' "$CURRENT" "$NEW"
printf '  src-tauri/Cargo.toml      %s -> %s\n' "$CARGO_CURRENT" "$NEW"
printf '  src-tauri/tauri.conf.json %s -> %s\n' "$TAURI_CURRENT" "$NEW"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n--dry-run：未写入任何文件\n'
  exit 0
fi

python3 - "$PKG_JSON" "$CARGO_TOML" "$TAURI_CONF" "$NEW" <<'PY'
import re, sys

pkg_path, cargo_path, tauri_path, version = sys.argv[1:5]


def set_json_version(path, version):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    pattern = re.compile(r'("version"\s*:\s*")[^"]*(")')
    new_text, count = pattern.subn(
        lambda m: m.group(1) + version + m.group(2), text, count=1
    )
    if count != 1:
        raise SystemExit(f"{path}: 找不到可替换的 version 字段")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(new_text)


def set_cargo_version(path, version):
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines(keepends=True)
    section = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped
            continue
        if section == "[package]" and re.match(r"\s*version\s*=", line):
            lines[index] = re.sub(
                r'(version\s*=\s*)"[^"]*"',
                lambda m: m.group(1) + f'"{version}"',
                line,
                count=1,
            )
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("".join(lines))
            return
    raise SystemExit(f"{path}: [package] 段里找不到 version")


set_json_version(pkg_path, version)
set_cargo_version(cargo_path, version)
set_json_version(tauri_path, version)
PY

FAILED=0
for pair in "package.json:$(read_pkg_version)" \
            "src-tauri/Cargo.toml:$(read_cargo_version)" \
            "src-tauri/tauri.conf.json:$(read_tauri_version)"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ "$value" = "$NEW" ]; then
    printf '  ✓ %-28s %s\n' "$name" "$value"
  else
    printf '  ✗ %-28s 期望 %s，实际 %s\n' "$name" "$NEW" "$value" >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  die "回读校验失败，三处版本不一致"
fi

printf '\n版本已更新为 %s\n' "$NEW"
printf '提醒：Cargo.lock 未改动，下次 cargo 构建会自动更新。\n'

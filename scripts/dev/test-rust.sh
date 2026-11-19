#!/usr/bin/env bash
#
# 用法：
#   bash scripts/dev/test-rust.sh --lib
#   bash scripts/dev/test-rust.sh --lib agent::questions
#   bash scripts/dev/test-rust.sh --bin veyl-helper tun::trust
#
# 为什么需要它：`cargo test` 带测试 cfg 与 dev-dependencies，cargo 对共享依赖
# （tauri / wry / claurst_* …）的特性合并结果与 `tauri build` 不同。两者共用
# src-tauri/target/debug 时，跑一次测试就把构建缓存作废一次，下一次 `tun-dev.sh`
# 又要整片重编（2026-11-19 实测：11:34 跑测试，11:39 的构建重编了 75 个 rlib）。
#
# 这里把测试放到独立 target 目录：`src-tauri/target/cargo-test`（可用
# VEYL_TEST_TARGET_DIR 覆盖）。第一次运行会把依赖编一遍，之后只有改动到的
# crate 重编；主构建目录不再被测试影响。
#
# 不要把 CARGO_TARGET_DIR 全局 export 到 shell 里——那只会在别处制造同样的分裂。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CARGO_TARGET_DIR="${VEYL_TEST_TARGET_DIR:-$ROOT/src-tauri/target/cargo-test}"

cd "$ROOT/src-tauri"
exec cargo test "$@"

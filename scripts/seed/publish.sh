#!/usr/bin/env bash
# 发布免费节点种子：改 cloudflare/control-plane/src/seed.ts → 跑这一条。
#
# 用法：
#   PAGES_SEED_DIR=/path/to/pages-repo bash scripts/seed/publish.sh
#   ... --allow-dirty               工作区有未提交改动时显式放行
#   ... --allow-version-unknown     线上不可达时跳过版本比较（会打印留痕）
#   ... --skip-fallback             明确知道不影响连接时才跳过兜底（醒目警告）
#
# 等价环境变量：SEED_PUBLISH_ALLOW_DIRTY=1 / SEED_PUBLISH_ALLOW_VERSION_UNKNOWN=1
#              SEED_PUBLISH_SKIP_FALLBACK=1
#
# 需要产品负责人手动做的一次性步骤：
#   1. 在 cloudflare/control-plane 下执行 `npx wrangler login`
#      （或设置 CLOUDFLARE_API_TOKEN）。
#   2. 准备一个 checkout 好的 GitHub Pages 仓库，把路径传给 PAGES_SEED_DIR；
#      推送凭据由运维配置。兜底是发布的一部分：未设置即发布失败
#      （确实不需要时显式 --skip-fallback）。
#
# 守卫（任一不过即中止）：
#   - 当前分支必须是 main，并打印 HEAD；
#   - 工作区必须干净（除非 --allow-dirty）；
#   - version 必须严格大于线上；
#   - updated_at 必须能解析且不超过 24 小时；
#   - 线上不可达时必须显式 --allow-version-unknown。
#
# 回滚：git revert 那次提交，再跑一次本脚本。不要删数据。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CP="$ROOT/cloudflare/control-plane"
SEED_URL="${VEYL_SEED_URL_PUBLIC:-https://veyl.dessage.xyz/v1/seed}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ALLOW_DIRTY="${SEED_PUBLISH_ALLOW_DIRTY:-0}"
ALLOW_VERSION_UNKNOWN="${SEED_PUBLISH_ALLOW_VERSION_UNKNOWN:-0}"
SKIP_FALLBACK="${SEED_PUBLISH_SKIP_FALLBACK:-0}"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-version-unknown) ALLOW_VERSION_UNKNOWN=1 ;;
    --skip-fallback) SKIP_FALLBACK=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 看用法）" >&2
      exit 2
      ;;
  esac
done

# ---- 守卫 ----
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "当前分支是 $BRANCH，发布只允许在 main 上进行。" >&2
  exit 1
fi
echo "分支: $BRANCH"
echo "HEAD: $HEAD_SHA"

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    echo "工作区有未提交改动：wrangler deploy 会把这些改动一起发布。" >&2
    git -C "$ROOT" status --short >&2
    echo "确认要发布当前工作区，请加 --allow-dirty（或 SEED_PUBLISH_ALLOW_DIRTY=1）。" >&2
    exit 1
  fi
  echo "警告：工作区不干净，已按 --allow-dirty 放行。"
fi

if [ "$SKIP_FALLBACK" != "1" ]; then
  if [ -z "${PAGES_SEED_DIR:-}" ]; then
    echo "PAGES_SEED_DIR 未设置：兜底发布是本次发布的一部分。" >&2
    echo "先完成兜底仓库的一次性配置，或明确知道不影响连接时加 --skip-fallback。" >&2
    exit 1
  fi
  if ! git -C "$PAGES_SEED_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    echo "PAGES_SEED_DIR 不是 git 仓库：$PAGES_SEED_DIR" >&2
    exit 1
  fi
else
  echo "⚠ 已按 --skip-fallback 跳过兜底：主源可用，但兜底会落后。"
fi

cd "$CP"

echo "== 1/6 类型检查 =="
npm run typecheck

echo "== 2/6 种子数据校验 =="
npx vitest run test/seed.test.ts

echo "== 3/6 生成本地正文字节与 ETag =="
npx vite-node "$ROOT/scripts/seed/print_seed.ts" "$TMP/local.json" "$TMP/local.etag"

echo "== 4/6 部署前校验 version / updated_at =="
node -e '
const fs = require("fs");
const local = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const stamp = Date.parse(local.updated_at);
if (!Number.isFinite(stamp)) {
  console.error(`updated_at 不可解析：${local.updated_at}`);
  process.exit(1);
}
const now = Date.now();
if (now - stamp > 24 * 60 * 60 * 1000) {
  console.error(`updated_at 超过 24 小时：${local.updated_at}`);
  process.exit(1);
}
if (stamp - now > 5 * 60 * 1000) {
  console.error(`updated_at 晚于当前时间（允许 5 分钟时钟偏差）：${local.updated_at}`);
  process.exit(1);
}
console.log(`  version: ${local.version}  updated_at: ${local.updated_at}`);
' "$TMP/local.json"

if curl -fsS --max-time 10 "$SEED_URL" -o "$TMP/previous.json"; then
  node -e '
const fs = require("fs");
const local = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const previous = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Number.isInteger(local.version) || !Number.isInteger(previous.version)) {
  console.error("version 不是整数，无法比较");
  process.exit(1);
}
if (local.version <= previous.version) {
  console.error(`version 必须大于线上：本地 ${local.version} <= 线上 ${previous.version}`);
  process.exit(1);
}
console.log(`  线上 version: ${previous.version} → 本地 ${local.version}`);
' "$TMP/local.json" "$TMP/previous.json"
elif [ "$ALLOW_VERSION_UNKNOWN" = "1" ]; then
  echo "⚠ 未能核对线上版本：线上不可达，已按 --allow-version-unknown 跳过比较。"
  echo "  留痕: version check skipped at $(date -u +%Y-%m-%dT%H:%M:%SZ) HEAD=$HEAD_SHA"
else
  echo "线上不可达，无法确认 version 是否递增。确认要发布请加 --allow-version-unknown。" >&2
  exit 1
fi

echo "== 5/6 部署 Worker =="
npx wrangler deploy

echo "== 6/6 核对线上 =="
online_ok=0
for _ in $(seq 1 12); do
  if curl -fsS --max-time 10 "$SEED_URL" -o "$TMP/online.json"; then
    if cmp -s "$TMP/local.json" "$TMP/online.json"; then
      online_ok=1
      break
    fi
  fi
  sleep 5
done

local_hash="$(shasum -a 256 "$TMP/local.json" | awk '{print $1}')"
if [ "$online_ok" != "1" ]; then
  online_hash="$( [ -s "$TMP/online.json" ] && shasum -a 256 "$TMP/online.json" | awk '{print $1}' || echo '(未取到)' )"
  echo "线上正文与本地不一致（部署可能还没生效，或缓存/路由不对）" >&2
  echo "  本地 sha256: $local_hash" >&2
  echo "  线上 sha256: $online_hash" >&2
  exit 1
fi

echo "线上已生效"
echo "  主源: $SEED_URL"
echo "  ETag: $(cat "$TMP/local.etag")"
echo "  正文 sha256: $local_hash"

echo "== 兜底：GitHub Pages =="
if [ "$SKIP_FALLBACK" = "1" ]; then
  echo "⚠ 已跳过兜底（--skip-fallback）：兜底会落后于主源。"
  exit 0
fi
cp "$TMP/local.json" "$PAGES_SEED_DIR/veyl_seed.json"
git -C "$PAGES_SEED_DIR" add veyl_seed.json
if git -C "$PAGES_SEED_DIR" diff --cached --quiet; then
  echo "  兜底: 无变化"
else
  git -C "$PAGES_SEED_DIR" commit -m "seed: update free nodes" >/dev/null
  if ! git -C "$PAGES_SEED_DIR" push; then
    echo "兜底推送失败：主源已生效，但本次发布按失败处理。" >&2
    exit 1
  fi
  echo "  兜底: 已推送（GitHub Pages 需要一次构建）"
fi

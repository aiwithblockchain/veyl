// 发布脚本用：把 Worker 实际会返回的正文与 ETag 写到两个文件。
// 不参与 control-plane 的 tsconfig（只覆盖 src 与 test）。
import { writeFileSync } from "node:fs";

import { seedBody, seedEtag } from "../../cloudflare/control-plane/src/seed";

const [bodyPath, etagPath] = process.argv.slice(2);
if (!bodyPath || !etagPath) {
  console.error("用法：vite-node scripts/seed/print_seed.ts <body.json> <etag.txt>");
  process.exit(2);
}
writeFileSync(bodyPath, seedBody());
writeFileSync(etagPath, await seedEtag());

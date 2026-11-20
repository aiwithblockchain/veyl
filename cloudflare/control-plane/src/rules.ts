// 国内分流规则集：随 Worker 打包（wrangler `rules` 的 Data 模块），公开只读下发。
// .srs 供 sing-box profile，.mrs 供 Clash rule-providers；来源、大小与 sha256 见 assets/rules/README.md。

import geoipCnMrs from "../assets/rules/geoip-cn.mrs";
import geoipCn from "../assets/rules/geoip-cn.srs";
import geositeCnMrs from "../assets/rules/geosite-cn.mrs";
import geositeCn from "../assets/rules/geosite-cn.srs";

const RULE_SETS: ReadonlyMap<string, ArrayBuffer> = new Map([
  ["/rules/geosite-cn.srs", geositeCn],
  ["/rules/geoip-cn.srs", geoipCn],
  ["/rules/geosite-cn.mrs", geositeCnMrs],
  ["/rules/geoip-cn.mrs", geoipCnMrs],
]);

/** 规则是公开数据：不认证也不加 no-store，允许客户端与中间缓存一天。 */
export function handleRules(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const body = RULE_SETS.get(new URL(request.url).pathname);
  if (!body) return null;
  // 复制一份：Response 不该持有跨请求共享的同一个 ArrayBuffer。
  return new Response(request.method === "HEAD" ? null : body.slice(0), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

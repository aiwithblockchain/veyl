// wrangler 的 Data 规则把 .srs / .mrs 以 ArrayBuffer 形式打进 Worker（见 wrangler.jsonc 的 rules）。
declare module "*.srs" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.mrs" {
  const data: ArrayBuffer;
  export default data;
}

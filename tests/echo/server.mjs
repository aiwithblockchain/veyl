#!/usr/bin/env node
// 回显服务：用于验证「代理链路是否真的通」。
// 启动：node tests/echo/server.mjs --port 18080
// 断言方式：通过 mixed 入站请求 / 返回 AIVPN_ECHO_OK；直连时同样返回，
// 因此判断是否走了代理要看 sing-box 日志里的 inbound/outbound 行，而不是响应内容。

import http from "node:http";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 18080;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/ip")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ip: "203.0.113.7", region: "JP", source: "mock" }));
  }
  if (req.url.startsWith("/slow")) {
    return setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("AIVPN_ECHO_SLOW\n");
    }, 8000);
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("AIVPN_ECHO_OK\n");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[echo] listening on http://127.0.0.1:${PORT}`);
});

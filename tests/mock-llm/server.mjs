#!/usr/bin/env node
// OpenAI 兼容 LLM mock。按剧本返回 tool_calls，供 E2E 稳定复现。
// 启动：node tests/mock-llm/server.mjs --port 18091
// 剧本选择：用户消息里带 [scenario:connect-jp]；未带则用默认剧本。
// 剧本轮次：按请求里已出现的 assistant 消息数量推进，因此服务端无状态。

import http from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, "..", "fixtures", "llm-scenarios");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 18091;

const scenarios = new Map();
if (existsSync(SCENARIO_DIR)) {
  for (const f of readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8"));
    scenarios.set(s.name, s);
  }
}

const stats = { requests: 0, byScenario: {}, authFailures: 0 };
let lastRequest = null;
const DEFAULT_SCENARIO = process.env.MOCK_LLM_DEFAULT_SCENARIO || "connect-jp";

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => p.text || "").join(" ");
    }
  }
  return "";
}

function pickScenario(messages) {
  const text = lastUserText(messages);
  const m = text.match(/\[scenario:([a-z0-9-]+)\]/i);
  const name = m ? m[1] : DEFAULT_SCENARIO;
  const scenario = scenarios.get(name) || scenarios.values().next().value;
  return { name: scenario?.name || "none", scenario };
}

function isBadKey(req) {
  const auth = req.headers.authorization || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return !key || /invalid|bad|expired/i.test(key);
}

function chunk(delta, finish = null, model = "deepseek-chat") {
  return {
    id: `chatcmpl-mock${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  // 最近一次请求的原始消息数组：用于断言「节点凭据没有进入模型上下文」
  if (url.pathname === "/__last_request") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(lastRequest ?? { messages: null }));
  }
  if (url.pathname === "/__reset") {
    stats.requests = 0;
    stats.byScenario = {};
    stats.authFailures = 0;
    lastRequest = null;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  if (url.pathname === "/v1/models") {
    if (isBadKey(req)) {
      stats.authFailures++;
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat", object: "model" }] }));
  }

  if (url.pathname !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (isBadKey(req)) {
      stats.authFailures++;
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }));
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end('{"error":"bad_json"}');
      return;
    }

    const messages = payload.messages || [];
    lastRequest = { at: Date.now(), model: payload.model, messages };
    const { name, scenario } = pickScenario(messages);
    stats.requests++;
    stats.byScenario[name] = (stats.byScenario[name] || 0) + 1;

    const turnIndex = messages.filter((m) => m.role === "assistant").length;
    const turns = scenario?.turns || [];
    const turn = turns[turnIndex];

    const model = payload.model || "deepseek-chat";
    const stream = payload.stream !== false;

    // 剧本走完：给一句收尾文本
    if (!turn) {
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "（剧本已结束）" }, finish_reason: "stop" }],
          })
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "（剧本已结束）" }, null, model))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop", model))}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const toolCalls = (turn.tool_calls || []).map((tc, i) => ({
      index: i,
      id: `call_${turnIndex}_${i}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
    }));

    if (!stream) {
      const message = { role: "assistant", content: turn.text || null };
      if (toolCalls.length) message.tool_calls = toolCalls;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        })
      );
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (toolCalls.length) {
      res.write(
        `data: ${JSON.stringify(chunk({ role: "assistant", tool_calls: toolCalls }, null, model))}\n\n`
      );
      res.write(`data: ${JSON.stringify(chunk({}, "tool_calls", model))}\n\n`);
    } else {
      const text = turn.text || "";
      // 切成小块，模拟流式
      const pieces = text.match(/[\s\S]{1,12}/g) || [""];
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }, null, model))}\n\n`);
      for (const p of pieces) {
        res.write(`data: ${JSON.stringify(chunk({ content: p }, null, model))}\n\n`);
      }
      res.write(`data: ${JSON.stringify(chunk({}, "stop", model))}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT} scenarios=${[...scenarios.keys()].join(",") || "none"}`);
});

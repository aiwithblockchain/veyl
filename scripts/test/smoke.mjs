#!/usr/bin/env node
// 冒烟断言：mock 目录服务 + mock LLM + 回显服务。
// 由 scripts/test/smoke.sh 调用（它负责起停进程），也可单独跑（需先 --start）。
//
// 断言的是「链路形状」而不是业务实现：设备注册 → 目录查询 → 剧本推进 → 回显可达。
// 真正的「连接 → 状态 → 断开」需要 sing-box 内核，由 smoke.sh 的第二段负责。

const CATALOG = `http://127.0.0.1:${process.env.MOCK_CATALOG_PORT || 18090}`;
const LLM = `http://127.0.0.1:${process.env.MOCK_LLM_PORT || 18091}`;
const ECHO = `http://127.0.0.1:${process.env.MOCK_ECHO_PORT || 18080}`;

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `（${detail}）` : ""}`);
  }
}

async function getJSON(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text, json: text ? safeJSON(text) : null };
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  // --- 目录服务 ---
  const health = await getJSON(`${CATALOG}/__health`);
  check("目录服务健康", health.status === 200, `status=${health.status}`);

  await fetch(`${CATALOG}/__reset`, { method: "GET" }).catch(() => {});

  const reg = await getJSON(`${CATALOG}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: process.platform, app_version: "0.1.0" }),
  });
  const token = reg.json?.token;
  check("设备注册返回 token", reg.status === 201 && !!token, `status=${reg.status}`);

  const noAuth = await getJSON(`${CATALOG}/v1/catalog/nodes`);
  check("未带 token 的目录查询被拒", noAuth.status === 401, `status=${noAuth.status}`);

  const list = await getJSON(`${CATALOG}/v1/catalog/nodes?region=jp`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const nodes = list.json?.nodes ?? [];
  check("目录查询返回节点", list.status === 200 && nodes.length > 0, `nodes=${nodes.length}`);
  check(
    "列表不含凭据字段",
    !/credentials|"uuid"|"password"/.test(list.text),
    "列表响应里出现了凭据字段"
  );

  const detail = await getJSON(`${CATALOG}/v1/nodes/${nodes[0]?.id ?? "seed-jp-01"}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("详情接口返回完整节点", detail.status === 200 && !!detail.json?.credentials);

  // --- LLM 剧本 ---
  let messages = [{ role: "user", content: "连到日本 [scenario:connect-jp]" }];
  const expected = ["ConfigCreate", "VpnConnect", null];
  for (let i = 0; i < expected.length; i++) {
    const r = await getJSON(`${LLM}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-test-valid", "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", stream: false, messages }),
    });
    const m = r.json?.choices?.[0]?.message;
    const got = m?.tool_calls?.[0]?.function?.name ?? null;
    check(`剧本第 ${i + 1} 轮：${expected[i] ?? "文本"}`, got === expected[i], `实际=${got ?? m?.content}`);
    if (!m) break;
    messages.push({ role: "assistant", content: m.content ?? null, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
    if (m.tool_calls) messages.push({ role: "tool", tool_call_id: m.tool_calls[0].id, content: "{}" });
  }

  // 凭据不得进入模型上下文（TC-CAT-012 的自动化部分）
  const last = await getJSON(`${LLM}/__last_request`);
  const sent = JSON.stringify(last.json?.messages ?? []);
  check(
    "发给模型的请求不含节点凭据",
    !/"uuid"|"password"|"private_key"|"public_key"/.test(sent),
    "请求体里出现了凭据类字段"
  );

  // --- 回显 ---
  const echo = await getJSON(`${ECHO}/`);
  check("回显服务可达", echo.status === 200 && echo.text.includes("VEYL_ECHO_OK"));

  console.log();
  if (failed > 0) {
    console.log(`[smoke] ${failed} 项失败`);
    process.exit(1);
  }
  console.log("[smoke] mock 链路全部通过");
}

main().catch((err) => {
  console.error(`[smoke] 执行出错：${err.message}`);
  process.exit(1);
});

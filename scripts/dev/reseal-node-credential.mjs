#!/usr/bin/env node
// 一次性运维工具：把节点的新端口 / 新密码重新封成 `credentials` 行。
//
// 为什么需要它：控制面只在 enroll 时写凭据，没有重封入口；而客户端（桌面签名下发、
// 手机 profile 现拼）读的都是这一行。改服务器不改这一行，所有客户端拿到的还是旧值。
//
// 密钥只在本进程内存里，不打印、不落盘；输出只有一个 SQL 语句文件，写完请删。
//
//   node scripts/dev/reseal-node-credential.mjs \
//     --server srv_xxx --host 1.2.3.4 --port 45678 --db veyl-control-plane-dev-4 --env dev

import { webcrypto as crypto } from "node:crypto";
import { chmodSync, writeFileSync, writeSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const [name, inline] = token.slice(2).split("=");
  args.set(name, inline ?? process.argv[++i]);
}

function fatal(message) {
  // 同步写：process.exit 会把还没刷出去的 stderr 截掉。
  writeSync(2, `\n${message}\n`);
  process.exit(1);
}

function readLineHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(buffer.slice(0, newline).trim());
      });
      process.stdin.on("end", () => resolve(buffer.trim()));
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buffer = "";
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buffer.trim());
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f") buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readLineVisible(prompt) {
  process.stdout.write(prompt);
  for await (const chunk of process.stdin) {
    return chunk.toString("utf8").replace(/\r?\n$/, "").trim();
  }
  return "";
}

/** 粘贴带换行时，残留的那个换行会被下一次读取当成空输入：空答案一律重问。 */
async function askHidden(prompt) {
  for (;;) {
    const answer = await readLineHidden(prompt);
    if (answer) return answer;
  }
}

async function askVisible(prompt) {
  for (;;) {
    const answer = await readLineVisible(prompt);
    if (answer) return answer;
  }
}

const b64uDecode = (text) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
};
const b64uEncode = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const serverId = args.get("server") || (await askVisible("server_id（srv_…）："));
if (!/^srv_[A-Za-z0-9_-]+$/.test(serverId)) fatal("server_id 形状不对");

const host = args.get("host") || (await askVisible("节点 IP："));
if (!/^[0-9a-fA-F.:]+$/.test(host)) fatal("host 形状不对");

const port = Number(args.get("port") || (await askVisible("新端口：")));
if (!Number.isInteger(port) || port < 1 || port > 65535) fatal("端口不合法");

const password = args.get("password") || (await askHidden("新密码（不回显）："));
if (password.length < 8 || password.length > 256) fatal("密码长度不在 8–256");

const keyText = args.get("key") || (await askHidden("CREDENTIAL_ENC_KEY（不回显，本地 base64url）："));
const keyBytes = b64uDecode(keyText);
if (keyBytes.length !== 32) fatal("CREDENTIAL_ENC_KEY 解码后不是 32 字节");

const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
  "encrypt",
  "decrypt",
]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const plaintext = JSON.stringify({ host, port, password, method: "aes-256-gcm" });
const sealedBytes = new Uint8Array(
  await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
);

// 先自检：解不回原文就别写库。
const roundTrip = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealedBytes);
if (new TextDecoder().decode(roundTrip) !== plaintext) fatal("自检失败：解不回原文");

const dbName = args.get("db") || "veyl-control-plane-dev-4";
const envName = args.get("env") || "dev";
const outPath = args.get("out") || `/tmp/veyl-reseal-${serverId}.sql`;

const sql =
  "UPDATE credentials SET key_version = 1, " +
  `iv = '${b64uEncode(iv)}', ciphertext = '${b64uEncode(sealedBytes)}', destroyed_at = NULL ` +
  `WHERE server_id = '${serverId}';\n`;
writeFileSync(outPath, sql, { mode: 0o600 });
chmodSync(outPath, 0o600);

process.stdout.write(
  [
    "",
    `封装完成：${host}:${port} method=aes-256-gcm`,
    "",
    "1) 先看现状（应为 1 行）：",
    `   npx wrangler d1 execute ${dbName} --env ${envName} --remote --command "SELECT server_id, key_version, length(ciphertext) AS len FROM credentials WHERE server_id='${serverId}'"`,
    "",
    "2) 写回（rows_written 应为 1）：",
    `   npx wrangler d1 execute ${dbName} --env ${envName} --remote --file ${outPath}`,
    "",
    "3) 删掉 SQL 文件：",
    `   rm -f ${outPath}`,
    "",
  ].join("\n"),
);

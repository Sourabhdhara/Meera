// Minimal WhatsApp MCP server over stdio.
// The saved .wwebjs_auth directory is intentionally preserved between runs.
import readline from "node:readline";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import whatsappPkg from "../node_modules/whatsapp-web.js/index.js";
import qrcode from "qrcode-terminal";
import { TOOL_DEFINITIONS, executeWhatsAppTool } from "./whatsapp-tools.mjs";

const { Client, LocalAuth } = whatsappPkg;
const appDir = path.dirname(fileURLToPath(import.meta.url));
let state = "starting";
let lastQr = false;
let qrText = "";
let client;
const statusFile = path.join(appDir, ".mcp-status.json");
const lockFile = path.join(appDir, ".mcp.lock");
const userDataDir = path.join(appDir, ".wwebjs_auth", "session");
let relinkRequired = false;
try { relinkRequired = JSON.parse(fsSync.readFileSync(statusFile, "utf8")).state === "unlinked"; } catch {}

function cleanupOwnedBrowser() {
  if (process.platform !== "win32") return;
  const escaped = userDataDir.replace(/'/g, "''");
  const command = `$profile='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' -and $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: "ignore" }); } catch {}
}

function writeStatus() {
  try { fsSync.writeFileSync(statusFile, JSON.stringify({ state, qr_required: lastQr, qr: qrText, pid: process.pid, updated_at: new Date().toISOString() }, null, 2)); } catch {}
}

function acquireLock() {
  try {
    if (fsSync.existsSync(lockFile)) {
      const previous = JSON.parse(fsSync.readFileSync(lockFile, "utf8"));
      let alive = false;
      try { process.kill(previous.pid, 0); alive = true; } catch {}
      let previousState = "";
      try { previousState = JSON.parse(fsSync.readFileSync(statusFile, "utf8")).state || ""; } catch {}
      let fresh = false;
      try { fresh = Date.now() - new Date(JSON.parse(fsSync.readFileSync(statusFile, "utf8")).updated_at).getTime() < 30000; } catch {}
      if (alive && fresh && previousState !== "stopped" && previousState !== "unlinked") return false;
      if (alive && (previousState === "stopped" || previousState === "unlinked")) {
        try { execFileSync("taskkill", ["/pid", String(previous.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
      }
      try { fsSync.unlinkSync(lockFile); } catch {}
    }
    fsSync.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
    return true;
  } catch { return false; }
}

if (!acquireLock()) {
  process.stderr.write("[WhatsApp MCP] Another WhatsApp MCP process is already running.\n");
  process.exit(11);
}
writeStatus();
const cleanup = () => { try { fsSync.unlinkSync(lockFile); } catch {} writeStatus(); };
process.once("exit", cleanup);
process.once("SIGTERM", () => { cleanup(); process.exit(0); });
process.once("SIGINT", () => { cleanup(); process.exit(0); });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(text, structuredContent) {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

async function startWhatsApp() {
  cleanupOwnedBrowser();
  if (relinkRequired) {
    try { await fs.rm(path.join(appDir, ".wwebjs_auth"), { recursive: true, force: true }); } catch {}
    relinkRequired = false;
  }
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(appDir, ".wwebjs_auth") }),
    puppeteer: {
      timeout: 120000,
      protocolTimeout: 120000,
      args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"]
    }
  });
  let readyPoll;
  const beginReadyPoll = () => {
    clearInterval(readyPoll);
    const started = Date.now();
    readyPoll = setInterval(async () => {
      try {
        const connectionState = await client.getState();
        if (connectionState === "CONNECTED") {
          state = "ready"; lastQr = false; qrText = ""; writeStatus(); clearInterval(readyPoll);
        } else if (Date.now() - started > 90000) {
          state = `authenticated_waiting_for_ready:${connectionState || "unknown"}`; writeStatus(); clearInterval(readyPoll);
        }
      } catch {}
    }, 2000);
  };
  client.on("qr", (qr) => {
    lastQr = true;
    state = "qr_required";
    writeStatus();
    qrcode.generate(qr, { small: true }, (code) => { qrText = code; writeStatus(); });
  });
  client.on("authenticated", () => { state = "authenticated"; writeStatus(); beginReadyPoll(); });
  client.on("ready", () => { state = "ready"; lastQr = false; qrText = ""; writeStatus(); });
  client.on("auth_failure", (message) => { state = `auth_failure: ${message}`; writeStatus(); });
  client.on("disconnected", (reason) => { state = `disconnected: ${reason}`; writeStatus(); });
  await client.initialize();
}

async function callTool(name, args = {}) {
  if (TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
    const response = await executeWhatsAppTool(name, args, client, state);
    if (name === "whatsapp_delink") { state = "unlinked"; lastQr = true; writeStatus(); }
    return response;
  }
  if (name === "whatsapp_status") return result(JSON.stringify({ state, qr_required: lastQr }));
  if (name === "whatsapp_delink") {
    try { await client?.logout(); } catch {}
    try { await fs.rm(path.resolve(".wwebjs_auth"), { recursive: true, force: true }); } catch {}
    state = "unlinked";
    lastQr = true;
    writeStatus();
    return result("WhatsApp was delinked. Start the server again to generate a new QR code.");
  }
  if (state !== "ready") return result(`WhatsApp is not ready. Current state: ${state}`);
  if (name === "whatsapp_send_message") {
    const chatId = String(args.chat_id || "").trim();
    const message = String(args.message || "").trim();
    if (!chatId || !message) return result("chat_id and message are required.");
    const normalized = chatId.includes("@") ? chatId : `${chatId.replace(/\D/g, "")}@c.us`;
    await client.sendMessage(normalized, message);
    return result(`Message sent to ${normalized}.`);
  }
  if (name === "whatsapp_list_chats") {
    const chats = await client.getChats();
    const list = chats.slice(0, 100).map((chat) => ({ id: chat.id._serialized, name: chat.name, is_group: chat.isGroup }));
    return result(JSON.stringify(list), { chats: list });
  }
  return result(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  try {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "meera-whatsapp", version: "1.0.0" } } });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOL_DEFINITIONS } });
    } else if (request.method === "tools/call") {
      send({ jsonrpc: "2.0", id: request.id, result: await callTool(request.params?.name, request.params?.arguments) });
    } else if (request.id !== undefined && request.method !== "notifications/initialized") {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error?.message || String(error) } });
  }
});

startWhatsApp().catch(async (error) => {
  process.stderr.write(`[WhatsApp MCP] initialize failed: ${error.stack || error}\n`);
  try { await client?.destroy(); } catch {}
  state = `error: ${error.message}`;
  writeStatus();
});

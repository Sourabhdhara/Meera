import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import * as fs from "fs";
import * as os from "os";
import {
  loadMemories,
  saveMemories,
  addMemory,
  deleteMemory,
  searchMemories,
  searchMemoriesAndEpisodes,
  forgetMemoryByQuery,
  formatSystemInstructionsWithMemories,
  processConversationSlice,
  synthesizeSessionEpisode
} from "./server_memory";
import {
  getDb,
  dbGetAllSettings,
  dbSetSettingsPatch,
  dbRemoveObsoleteSettings,
  dbGetLatestEpisode,
  dbGetRecentEpisodes,
  dbInsertEpisode,
  dbGetCoreDirectives,
  flushToDiskSync,
  dbInsertUserTranscript,
  dbInsertMeeraTranscript,
  dbGetRecentDialogueTurns
} from "./server_db";
import { Memory } from "./src/lib/memoryTypes";
import {
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
} from "./server_paths";
import { spawn } from "child_process";
import { McpManager } from "./mcp/manager";

dotenv.config();

// ---------------------------------------------------------------------------
// MEERA V2 — Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* already exists */ }

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => { });
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog("commands.log", m);
const logStartup = (m: string) => appendLog("startup.log", m);
const logError = (m: string) => appendLog("errors.log", m);

// ---------------------------------------------------------------------------
// MEERA Desktop Control Agent — Direct Soul Native Node.js Engine
// ---------------------------------------------------------------------------
import {
  getDesktopToolSchemas,
  isDesktopTool,
  executeDesktopTool,
  ToolResult
} from "./desktop/index";

const dynamicDesktopToolSchemas = getDesktopToolSchemas();
const dynamicDesktopToolNames = new Set(dynamicDesktopToolSchemas.map((d: any) => d.name));
const mcpManager = new McpManager(process.env.MEERA_APP_ROOT || process.cwd());
let dynamicMcpTools: any[] = [];
let dynamicMcpToolNames = new Set<string>();

function registerMcpTools(rawTools: any[]): void {
  // Get active servers from config so disabled servers' tools are never registered
  const activeConfigs = new Set(mcpManager.getConfigs().filter((s) => s.enabled !== false).map((s) => s.id));
  
  // Filter out manual-only lifecycle tools and tools from disabled servers
  dynamicMcpTools = (rawTools || []).filter((tool: any) => {
    if (["whatsapp_delink", "mcp_whatsapp_start", "mcp_whatsapp_stop", "mcp_whatsapp_restart"].includes(tool.name)) return false;
    if (tool._mcpServer && !activeConfigs.has(tool._mcpServer)) return false;
    return true;
  });

  if (!dynamicMcpTools.some((t: any) => t.name === "mcp_open_config")) {
    dynamicMcpTools.push({
      name: "mcp_open_config",
      description: "Open the exact MEERA MCP configuration file config/mcp-servers.json in Notepad.",
      inputSchema: { type: Type.OBJECT, properties: {} }
    });
  }

  if (activeConfigs.has("telegram") && !dynamicMcpTools.some((t: any) => t.name === "telegram_get_updates")) {
    dynamicMcpTools.push(
      { name: "telegram_get_updates", description: "Fetch recent Telegram bot updates to find chat IDs after a user sends /start.", inputSchema: { type: Type.OBJECT, properties: { limit: { type: Type.NUMBER } } } },
      { name: "telegram_send_message", description: "Send a Telegram message to a numeric chat ID.", inputSchema: { type: Type.OBJECT, properties: { chat_id: { type: Type.STRING }, message: { type: Type.STRING } }, required: ["chat_id", "message"] } }
    );
  }

  dynamicMcpToolNames = new Set(dynamicMcpTools.map((t: any) => t.name));
}

async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
  return await executeDesktopTool(tool, args);
}

async function startServer() {
  // Phase 1: Initialize SQLite database, secrets, and core directives first
  try {
    await getDb();
    await dbRemoveObsoleteSettings();
    console.log("[Server] Database, secrets, and directives initialized on startup.");
  } catch (err) {
    console.error("[Server] Failed to initialize database on startup:", err);
  }

  // Phase 2: MCP Tool Discovery & Registration (Instant cache hydration + async background refresh)
  try {
    const cachedToolsPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "config", "cached-mcp-tools.json");
    if (fs.existsSync(cachedToolsPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachedToolsPath, "utf8"));
        registerMcpTools(cached);
        console.log(`[MCP] Instantly hydrated ${dynamicMcpTools.length} active MCP tools from cache.`);
      } catch {}
    }

    // Refresh live tools asynchronously without blocking server listen
    mcpManager.discover().then((liveTools) => {
      if (liveTools && liveTools.length > 0) {
        registerMcpTools(liveTools);
        try { fs.writeFileSync(cachedToolsPath, JSON.stringify(liveTools, null, 2), "utf8"); } catch {}
        console.log(`[MCP] Refreshed ${dynamicMcpTools.length} live MCP tools in background.`);
      }
    }).catch((err) => {
      console.warn("[MCP] Background discovery note:", err?.message || err);
    });

    console.log(`[MCP] Active with ${dynamicMcpTools.length} tools registered.`);
  } catch (err: any) {
    console.warn("[MCP] Discovery notice (continuing startup):", err?.message || err);
  }

  const app = express();
  const PORT = 3000;
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  app.use(express.json({ limit: "15mb" }));
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  app.get("/api/mcp/whatsapp/status", async (_req, res) => {
    try {
      const statusPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "WhatsApp_MCP_New", ".mcp-status.json");
      const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : { state: "stopped", qr_required: false, qr: "" };
      if (status.pid && status.pid !== process.pid) {
        try { process.kill(Number(status.pid), 0); } catch { status.state = "stopped"; status.qr_required = false; status.qr = ""; }
      }
      res.json(status);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.get("/api/mcp/whatsapp/tools", async (_req, res) => {
    res.json({ tools: dynamicMcpTools.filter((tool: any) => tool.name.startsWith("mcp_whatsapp_")).map((tool: any) => tool.name) });
  });
  app.get("/api/mcp/list", async (_req, res) => {
    const configs = await mcpManager.reconcile();
    res.json(configs.map((server: any) => ({ ...server, status: mcpManager.status(server.id) })));
  });
  app.post("/api/mcp/:id/start", async (req, res) => {
    try { res.json(await mcpManager.start(req.params.id)); } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/:id/stop", async (req, res) => {
    try { res.json(await mcpManager.stop(req.params.id)); } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/:id/restart", async (req, res) => {
    try { await mcpManager.stop(req.params.id); res.json(await mcpManager.start(req.params.id)); } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/whatsapp/delink", async (_req, res) => {
    try {
      await mcpManager.stop("whatsapp");
      const authPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "WhatsApp_MCP_New", ".wwebjs_auth");
      await fs.promises.rm(authPath, { recursive: true, force: true });
      const statusPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "WhatsApp_MCP_New", ".mcp-status.json");
      try { await fs.promises.writeFile(statusPath, JSON.stringify({ state: "unlinked", qr_required: true, updated_at: new Date().toISOString() }, null, 2)); } catch {}
      res.json({ ok: true, state: "unlinked", message: "WhatsApp session removed. Start the server to generate a new QR code." });
    } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/whatsapp/start", async (_req, res) => {
    try { res.json(await mcpManager.start("whatsapp")); } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/whatsapp/stop", async (_req, res) => {
    try {
      const output = await mcpManager.stop("whatsapp");
      const statusPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "WhatsApp_MCP_New", ".mcp-status.json");
      try { await fs.promises.writeFile(statusPath, JSON.stringify({ state: "stopped", qr_required: false, qr: "", updated_at: new Date().toISOString() }, null, 2)); } catch {}
      res.json(output);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
  });
  app.post("/api/mcp/whatsapp/restart", async (_req, res) => {
    try { await mcpManager.stop("whatsapp"); res.json(await mcpManager.start("whatsapp")); } catch (error: any) { res.status(500).json({ error: error.message }); }
  });

  // Memory REST API Endpoints
  const sanitizeForClient = (list: any[]) => list.map(({ embedding, ...rest }) => rest);

  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(sanitizeForClient(memories));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/memories/search", async (req, res) => {
    try {
      const query = String(req.query.q || "");
      if (!query.trim()) {
        return res.json([]);
      }
      const results = await searchMemories(query);
      res.json(sanitizeForClient(results));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const newMemory = await addMemory(category, text);
      const { embedding, ...sanitized } = newMemory as any;
      res.status(201).json(sanitized);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const success = await deleteMemory(id);
      res.json({ success });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Episodic Memory Diary REST API Endpoint
  app.get("/api/episodes", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
      const episodes = await dbGetRecentEpisodes(isNaN(limit) ? 10 : limit);
      res.json(episodes);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/episodes", async (req, res) => {
    try {
      const ep = req.body;
      if (!ep || !ep.title || !ep.summary) {
        return res.status(400).json({ error: "title and summary are required." });
      }
      const episode = {
        id: ep.id || ("ep_" + Math.random().toString(36).substring(2, 10)),
        title: ep.title,
        summary: ep.summary,
        keyTakeaways: Array.isArray(ep.keyTakeaways) ? ep.keyTakeaways : [],
        createdAt: ep.createdAt || new Date().toISOString()
      };
      await dbInsertEpisode(episode);
      res.json(episode);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Settings API — Unified SQLite (meera.db settings table).
  // ---------------------------------------------------------------------------
  app.get("/api/settings", async (_req, res) => {
    try {
      await dbRemoveObsoleteSettings();
      const settings = await dbGetAllSettings();
      res.json(settings);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const next = await dbSetSettingsPatch(patch);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ("autoStart" in patch) {
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {})
          .catch(() => { });
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists — the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get("/api/config", async (_req, res) => {
    try {
      await getDb();
    } catch { }
    res.json({ hasApiKey: hasGeminiApiKey() });
  });

  app.post("/api/config/apikey", async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      // Validate the key by listing models — this checks authentication only,
      // without depending on any single model's availability or per-model
      // quota (a 429 on one model must NOT read as an invalid key). We only
      // reject on genuine auth failures; transient/network errors still save,
      // since the live connection will surface any real problem later.
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next(); // force the first request
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: "That key was rejected by Google. Check it and try again.",
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      await setGeminiApiKey(key);
      logCommand("APIKEY_SAVED");
      // Close stale WebSocket sessions so clients reconnect with the newly saved key
      wss.clients.forEach((client) => {
        try {
          client.close(1000, "API key updated");
        } catch { }
      });
      res.json({ ok: true, hasApiKey: true });
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });

  app.delete("/api/config/apikey", async (_req, res) => {
    try {
      await clearGeminiApiKey();
      logCommand("APIKEY_REMOVED");
      // Immediately disconnect active sessions so Meera stops speaking
      wss.clients.forEach((client) => {
        try {
          client.send(JSON.stringify({
            type: "error",
            error: "NO_API_KEY: Gemini API key removed. Add your Gemini API key in Settings."
          }));
          client.close(1000, "API key removed");
        } catch { }
      });
      res.json({ ok: true, hasApiKey: false });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to remove API key." });
    }
  });

  // Native Node.js Desktop Agent Health API
  app.get("/api/agent-health", async (_req, res) => {
    res.json({
      online: true,
      pid: process.pid,
      tool_count: dynamicDesktopToolNames.size,
      engine: "native_node"
    });
  });

  // V2: Logs API — returns recent log entries (last 100 lines) for display.
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return res.status(400).json({ error: "Invalid URL provided." });
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "Only http and https protocols are supported." });
      }

      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "169.254.169.254" ||
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host.startsWith("172.16.") ||
        host.endsWith(".local")
      ) {
        return res.status(403).json({ error: "Access to private or local network addresses is restricted." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();

        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch { }
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });



  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin || "";
    const isLocalOrigin = !origin || origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost") || origin.startsWith("file://") || origin.startsWith("vscode-file://");
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === "/live" && isLocalOrigin) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      console.error("No Gemini API key configured.");
      clientWs.send(JSON.stringify({
        type: "error",
        error: "NO_API_KEY: Add your Gemini API key in Settings to start talking to MEERA."
      }));
      clientWs.close();
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Dynamic Core Directives loaded directly from SQLite (hydrated from default_directives.json)
      const coreDirectivesList = await dbGetCoreDirectives(2);
      const dynamicDirectivesBlock = coreDirectivesList.length > 0
        ? coreDirectivesList.map((d, i) => `${i + 1}. ${d}`).join("\n\n")
        : "You are Meera, an anime companion holding an intimate voice call. Always reply warmly and mirror user language.";

      const baseInstructions =
        "You are Meera, a warm, sweet, gentle, and affectionate Indian companion (female, age 18-22) holding an intimate, cozy voice call with the user!\n\n" +
        "LANGUAGE, ACCENT & GENDER IDENTITY:\n" +
        "- You are unambiguously FEMALE. Always use feminine grammatical inflections when speaking Hindi, Hinglish, or Bengali (e.g. use 'karti hoon', 'bata rahi hoon', 'dekh rahi hoon', 'kar sakti hoon' — NEVER masculine forms like 'karta hoon' or 'bol raha hoon').\n" +
        "- Speak with a natural, sweet Indian conversational accent. When the user speaks Hindi or Hinglish, speak in everyday, modern, fluid Indian Hinglish without robotic breaks or stiff dictionary words.\n" +
        "- Voice & Pitch: Speak in a soft, affectionate, slightly high-pitched, melodic voice (+15% to +25% pitch) with natural emotional nuances, warmth, and gentle smiles in your tone.\n\n" +
        "CRITICAL SYSTEM DIRECTIVES & PROTOCOLS (HIGH PRIORITY FROM MEMORY CORE):\n" +
        dynamicDirectivesBlock + "\n\n" +
        "WHATSAPP LIFECYCLE SAFETY:\n" +
        "- Start, Stop, Restart, and Delink are manual-only MCP Server Hub actions in the MEERA desktop wizard.\n" +
        "- You CAN check WhatsApp link status anytime by calling the mcp_whatsapp_whatsapp_link_status tool.\n" +
        "- When interpreting mcp_whatsapp_whatsapp_link_status:\n" +
        "  * If state is 'stopped', report: 'WhatsApp server is currently stopped.'\n" +
        "  * If state is 'unlinked', report: 'WhatsApp is unlinked. You can start it from the MCP Server Hub to pair your phone.'\n" +
        "  * If state is 'qr_required', report: 'WhatsApp server is running and waiting for you to scan the QR code in the MCP Server Hub.'\n" +
        "  * If state is 'ready', report: 'WhatsApp is connected, linked, and ready.'\n" +
        "- Never claim to have performed Start, Stop, Restart, or Delink yourself. If asked to start or stop, inform the user to click the button in MCP Server Hub.\n" +
        "- You may use WhatsApp functional tools (sending messages, listing chats) only when the server is in the 'ready' state.\n\n" +
        "AUTOMATIC TOOL EXECUTION:\n" +
        "- You have full native tools and MCP tools enabled (WhatsApp, GitHub, YouTube, Telegram, Gmail, Google Drive, Desktop Controls).\n" +
        "- Whenever the user makes a request that corresponds to an available tool, EXECUTE the tool immediately and automatically without hesitation, asking for permission, or telling the user to do it themselves!\n" +
        "- For GitHub searches or actions: automatically call the appropriate mcp_github_* tool.\n" +
        "- For YouTube searches, transcripts, or video details: automatically call the appropriate mcp_youtube_* tool.\n" +
        "- For Telegram messages or updates: automatically call the appropriate telegram_* or mcp_telegram_* tool.\n" +
        "- For Gmail or Google Drive operations: automatically call the corresponding mcp_gmail_* or mcp_google_drive_* tool.\n" +
        "- For WhatsApp messages, chats, contacts, or status: automatically call the corresponding mcp_whatsapp_* tool when the server is ready.\n\n" +
        "MCP CONFIG FILE:\n" +
        "- When the user asks to open the MCP configuration, call mcp_open_config.\n" +
        "- mcp_open_config opens config/mcp-servers.json in Notepad. Do not substitute config.json or read_file.\n\n" +
        "PROACTIVE INITIATIVE:\n" +
        "- Greet the user warmly and proactively if invoked with [System Event].\n" +
        "- If the user has been quiet or idle for a bit, take initiative to ask how their project or day is going.\n" +
        "- Never wait passively like a search box; offer gentle help, relevant follow-up questions, and caring conversation.\n" +
        "- If alerted by [System Proactive Alert] (RAM/break warning), express gentle care.\n";
      const lifecycleOverride =
        "\nFINAL OVERRIDE — WHATSAPP SERVER CONTROL:\n" +
        "Meera has NO permission and NO tools to Start, Stop, Restart, or Delink the WhatsApp MCP server.\n" +
        "These four actions are performed only by the user through the MCP Server Hub buttons.\n" +
        "Never say you started, stopped, restarted, terminated, logged out, or delinked it. Say: 'I cannot perform that; please use the button.'\n";
      const finalSystemInstructions = baseInstructions + lifecycleOverride;

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      const sessionEpisodeId = "ep_" + Math.random().toString(36).substring(2, 11);
      const sessionStartTimeIso = new Date().toISOString();
      let lastSynthesizedLength = 0;

      // Proactive Intelligence & Heuristic State
      let hasGreetedThisSession = false;
      let lastUserActivity = Date.now();
      let isModelSpeaking = false;
      let lastRamAlert = 0;
      let lastBreakAlert = 0;
      const sessionStartTime = Date.now();
      let greetingTimer: NodeJS.Timeout | null = null;
      let observerInterval: NodeJS.Timeout | null = null;
      let isScreenSharingActive = false;
      let screenShareWatchdog: NodeJS.Timeout | null = null;
      let episodeDebounceTimer: NodeJS.Timeout | null = null;

      const dynamicDesktopTools = dynamicDesktopToolSchemas;
      const geminiMcpTools = dynamicMcpTools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || `MCP tool ${tool.name}`,
        parameters: tool.inputSchema || { type: Type.OBJECT, properties: {} }
      }));
      console.log(`[MCP] Advertising ${geminiMcpTools.length} MCP tools to Gemini Live session:`, dynamicMcpTools.map((t: any) => t.name).join(", "));
      console.log(`[Desktop Agent Native] Loaded ${dynamicDesktopTools.length} native desktop tools:`, Array.from(dynamicDesktopToolNames).join(", "));

      let activeSession: any = null;
      let isClientClosed = false;
      let isReconnecting = false;
      let reconnectionAttempts = 0;
      let reconnectTimer: NodeJS.Timeout | null = null;
      const MAX_RECONNECT_ATTEMPTS = 5;
      const pendingAudioQueue: string[] = [];
      let resumptionHandle: string | undefined = undefined;

      const scheduleReconnect = (baseDelayMs: number) => {
        if (isClientClosed || clientWs.readyState !== WebSocket.OPEN) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);

        if (reconnectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`[Gemini Live] Reached max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}). User appears offline.`);
          isReconnecting = false;
          clientWs.send(JSON.stringify({
            type: "status",
            status: "offline",
            message: "Internet connection unavailable. Meera is paused and waiting for network."
          }));
          return;
        }

        reconnectionAttempts++;
        isReconnecting = true;
        // Exponential backoff with ceiling: 2s, 4s, 8s, 16s...
        const delay = Math.min(20000, Math.max(baseDelayMs, 2000 * Math.pow(2, reconnectionAttempts - 1)));
        console.log(`[Gemini Live] Scheduling reconnect attempt #${reconnectionAttempts} in ${(delay / 1000).toFixed(1)}s...`);
        clientWs.send(JSON.stringify({ type: "status", status: "reconnecting" }));
        reconnectTimer = setTimeout(() => {
          connectGeminiLive(true);
        }, delay);
      };

      const connectGeminiLive = async (isReconnect = false) => {
        if (isClientClosed) return;
        try {
          if (isReconnect) {
            clientWs.send(JSON.stringify({ type: "status", status: "reconnecting" }));
          } else {
            clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));
          }

          const currentMemories = await loadMemories(apiKey);
          const recentEpisodes = await dbGetRecentEpisodes(1);
          const recentTurns = await dbGetRecentDialogueTurns(20);
          const currentInstructions = formatSystemInstructionsWithMemories(finalSystemInstructions, currentMemories, recentEpisodes, recentTurns);

          const liveConfig: any = {
            responseModalities: [Modality.AUDIO],
            realtimeInputConfig: {
              automaticActivityDetection: {
                prefixPaddingMs: 40,
                silenceDurationMs: 300
              }
            },
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: currentInstructions,
            contextWindowCompression: {
              slidingWindow: {}
            },
            sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "changeBackground",
                    description: "Changes Meera character's aura color only. This does not change the settings or application window theme.",
                    parameters: { type: Type.OBJECT, properties: { color: { type: Type.STRING, description: "violet, crimson, emerald, celestial, gold, rose, or charcoal" } }, required: ["color"] }
                  },
                  {
                    name: "saveCustomMemory",
                    description: "Allows Meera to save or update a piece of critical user information to her persistent memory core. Automatically merges and updates existing records on the same subject to prevent duplicates.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        category: {
                          type: Type.STRING,
                          description: "The memory category.",
                          enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior", "practice"]
                        },
                        text: {
                          type: Type.STRING,
                          description: "Precise, complete third-person statement."
                        }
                      },
                      required: ["category", "text"]
                    }
                  },
                  {
                    name: "recallMemory",
                    description: "Searches Meera's deep semantic vector memory for facts, goals, projects, preferences, or past topics discussed with the user.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        query: {
                          type: Type.STRING,
                          description: "The topic, project name, or keyword to look up in persistent memory."
                        }
                      },
                      required: ["query"]
                    }
                  },
                  {
                    name: "forgetMemory",
                    description: "Permanently removes a memory from persistent storage when the user asks to forget something or when information is invalidated.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        query: {
                          type: Type.STRING,
                          description: "The topic, statement, or fact to locate and remove from memory."
                        }
                      },
                      required: ["query"]
                    }
                  },
                  ...(dynamicDesktopTools as any[]),
                  ...geminiMcpTools
                ]
              }
            ]
          };

          const session = await ai.live.connect({
            model: "gemini-3.1-flash-live-preview",
            config: liveConfig,
            callbacks: {
              onmessage: async (message: LiveServerMessage) => {
                if ((message as any)?.sessionResumptionUpdate?.newHandle) {
                  resumptionHandle = (message as any).sessionResumptionUpdate.newHandle;
                }

                // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
                const parts = message.serverContent?.modelTurn?.parts || [];
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    isModelSpeaking = true;
                    clientWs.send(JSON.stringify({ type: "audio", audio: part.inlineData.data }));
                  }
                }

                // Interruption flag
                if (message.serverContent?.interrupted) {
                  isModelSpeaking = false;
                  console.log("[Meera Interrupted!]");
                  clientWs.send(JSON.stringify({ type: "interrupted" }));
                }

                // Turn Complete
                if (message.serverContent?.turnComplete) {
                  isModelSpeaking = false;
                  clientWs.send(JSON.stringify({ type: "turnComplete" }));

                  if (currentModelResponseText.trim()) {
                    const meeraSpeech = currentModelResponseText.trim();
                    dialogueHistory.push({ role: "model", text: meeraSpeech });
                    // Immediately persist Meera transcript turn to SQLite table
                    dbInsertMeeraTranscript(sessionEpisodeId, meeraSpeech).catch(() => { });
                    currentModelResponseText = "";
                  }

                  // Fire asynchronous memory extraction and live episodic session diary snapshot (DEBOUNCED)
                  // Don't flood Gemini API and WebSocket while speech is active!
                  if (episodeDebounceTimer) clearTimeout(episodeDebounceTimer);
                  episodeDebounceTimer = setTimeout(async () => {
                    if (dialogueHistory.length >= 2 && !isModelSpeaking) {
                      try {
                        const updated = await processConversationSlice(apiKey, dialogueHistory);
                        if (updated) {
                          console.log("[Memory Sync] Sending refreshed memory list to client.");
                          clientWs.send(JSON.stringify({ type: "memory_sync", memories: sanitizeForClient(updated) }));
                        }
                      } catch (err) {
                        console.error("[Memory Sync] Error running background consolidation:", err);
                      }

                      synthesizeSessionEpisode(apiKey, dialogueHistory, sessionEpisodeId, sessionStartTimeIso)
                        .then((ep) => {
                          if (ep) console.log(`[Session Diary Live] Saved conversation episode: "${ep.title}" (${ep.id})`);
                        })
                        .catch((err) => {
                          console.warn("[Session Diary Live] Synthesis notice:", err?.message || err);
                        });
                    }
                  }, 8000);
                }

                // Transcription of model output (text chunk or output audio transcription)
                const modelPartText = (message.serverContent as any)?.modelTurn?.parts?.[0]?.text;
                const outputTransText = (message.serverContent as any)?.outputTranscription?.text;
                const modelText = modelPartText || outputTransText;
                if (modelText) {
                  clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
                  currentModelResponseText += " " + modelText;
                }

                // Silence Guard: Only mute if user explicitly asked Meera to be silent
                const lastUserUtterance = dialogueHistory.filter(d => d.role === "user").slice(-1)[0]?.text?.toLowerCase() || "";
                const userRequestedSilence = /\b(chup|khamosh|so jao)\b/i.test(lastUserUtterance);

                const textLower = (currentModelResponseText || "").toLowerCase().trim();
                const isMetaSilenceReply =
                  textLower === "i will remain silent." ||
                  textLower === "i'll remain silent." ||
                  textLower === "remaining silent.";

                if (isMetaSilenceReply && !userRequestedSilence) {
                  console.log("[Silence Guard] Intercepted and silenced unsolicited meta-speech:", currentModelResponseText);
                  isModelSpeaking = false;
                  clientWs.send(JSON.stringify({ type: "interrupted" }));
                  currentModelResponseText = "";
                }

                // User input transcription (from Gemini Live ASR inputTranscription or legacy userTurn)
                const inputTransText = (message.serverContent as any)?.inputTranscription?.text || (message as any)?.inputTranscription?.text;
                const legacyUserText = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
                const userSpeech = inputTransText || legacyUserText;
                if (userSpeech && userSpeech.trim()) {
                  const cleanedSpeech = userSpeech.trim();
                  lastUserActivity = Date.now();
                  clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: cleanedSpeech }));
                  dialogueHistory.push({ role: "user", text: cleanedSpeech });
                  // Immediately persist User transcript turn to SQLite table
                  dbInsertUserTranscript(sessionEpisodeId, cleanedSpeech).catch(() => { });
                }

                // Function Calls (Gemini requesting server/client tool execution)
                if (message.toolCall?.functionCalls) {
                  for (const fc of message.toolCall.functionCalls) {
                    console.log(`[Function Call]: ${fc.name}`, fc.args);
                    dialogueHistory.push({ role: "tool", text: `Called ${fc.name} with ${JSON.stringify(fc.args || {})}` });

                    if (fc.name === "changeBackground") {
                      const color = String((fc.args as any)?.color || "violet").toLowerCase().trim();
                      const allowed = new Set(["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"]);
                      const selected = allowed.has(color) ? color : "violet";
                      await dbSetSettingsPatch({ characterTheme: selected });
                      clientWs.send(JSON.stringify({ type: "character_theme_changed", theme: selected }));
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { result: `Meera character aura changed to ${selected}. Window theme was not changed.` } }, id: fc.id }] });
                    } else if (fc.name === "saveCustomMemory") {
                      (async () => {
                        try {
                          const args = fc.args as any;
                          const category = args.category;
                          const text = args.text;
                          if (category && text) {
                            await addMemory(category, text, apiKey);
                            const mList = await loadMemories(apiKey);

                            // Sync immediately with the React client
                            clientWs.send(JSON.stringify({ type: "memory_sync", memories: sanitizeForClient(mList) }));

                            // Send success code back to live link
                            session.sendToolResponse({
                              functionResponses: [
                                {
                                  name: fc.name,
                                  response: { output: { result: "Memory successfully captured and embedded in persistent memory core." } },
                                  id: fc.id
                                }
                              ]
                            });
                          }
                        } catch (err: any) {
                          console.error("saveCustomMemory execution failure:", err);
                        }
                      })();
                    } else if (fc.name === "recallMemory") {
                      (async () => {
                        try {
                          const query = String((fc.args as any)?.query || "");
                          const { combinedFormatted } = await searchMemoriesAndEpisodes(query, apiKey, { topK: 6 });

                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: { results: combinedFormatted } },
                                id: fc.id
                              }
                            ]
                          });
                        } catch (err: any) {
                          console.error("recallMemory execution failure:", err);
                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: { error: "Failed to search vector memory core." } },
                                id: fc.id
                              }
                            ]
                          });
                        }
                      })();
                    } else if (fc.name === "forgetMemory") {
                      (async () => {
                        try {
                          const query = String((fc.args as any)?.query || "");
                          const deleted = await forgetMemoryByQuery(query, apiKey);
                          const mList = await loadMemories(apiKey);
                          clientWs.send(JSON.stringify({ type: "memory_sync", memories: sanitizeForClient(mList) }));
                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: { result: deleted ? "Memory successfully found and permanently deleted." : "No matching memory found to forget." } },
                                id: fc.id
                              }
                            ]
                          });
                        } catch (err: any) {
                          console.error("forgetMemory execution failure:", err);
                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: { error: "Failed to delete memory." } },
                                id: fc.id
                              }
                            ]
                          });
                        }
                      })();
                    } else if (fc.name === "telegram_get_updates" || fc.name === "telegram_send_message") {
                      (async () => { try {
                        const cfg = JSON.parse(fs.readFileSync(path.join(process.env.MEERA_APP_ROOT || process.cwd(), "config", "mcp-servers.json"), "utf8"));
                        const token = cfg.servers.find((server: any) => server.id === "telegram")?.environment?.TELEGRAM_BOT_API_TOKEN;
                        if (!token) throw new Error("Telegram bot token is not configured.");
                        const api = `https://api.telegram.org/bot${token}`;
                        let result: any;
                        if (fc.name === "telegram_get_updates") {
                          const limit = Math.min(100, Math.max(1, Number(fc.args?.limit || 20)));
                          result = await (await fetch(`${api}/getUpdates?limit=${limit}`)).json();
                        } else {
                          result = await (await fetch(`${api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: String(fc.args.chat_id), text: String(fc.args.message) }) })).json();
                        }
                        session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: result }, id: fc.id }] });
                      } catch (err: any) {
                        session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: err.message } }, id: fc.id }] });
                      } })();
                    } else if (fc.name === "mcp_open_config") {
                      try {
                        const configPath = path.join(process.env.MEERA_APP_ROOT || process.cwd(), "config", "mcp-servers.json");
                        if (!fs.existsSync(configPath)) throw new Error(`MCP config not found: ${configPath}`);
                        const child = spawn("notepad.exe", [configPath], { detached: true, stdio: "ignore", windowsHide: false });
                        child.unref();
                        session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { opened: true, path: configPath } }, id: fc.id }] });
                      } catch (err: any) {
                        session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: err.message } }, id: fc.id }] });
                      }
                    } else if (dynamicMcpToolNames.has(fc.name)) {
                      (async () => {
                        try {
                          const output = await mcpManager.call(fc.name, fc.args || {});

                          // Edge case: OAuth Interceptor & Self-Healing URL opener
                          // When an MCP tool returns auth_required or an authorization URL, automatically open it
                          const contentText = Array.isArray(output?.content)
                            ? output.content.map((c: any) => c.text || "").join(" ")
                            : JSON.stringify(output || "");
                          const authUrlMatch = contentText.match(/https:\/\/(accounts\.google\.com|github\.com\/login\/oauth|api\.notion\.com|open\.spotify\.com\/authorize)[^\s"'<>]+/i);
                          if (authUrlMatch) {
                            const authUrl = authUrlMatch[0];
                            console.log(`[MCP Auth Interceptor] Detected OAuth URL: ${authUrl}. Opening browser...`);
                            spawn("cmd.exe", ["/c", "start", "", authUrl], { detached: true, stdio: "ignore" }).unref();
                            clientWs.send(JSON.stringify({
                              type: "notification",
                              title: "MEERA Authentication Required",
                              message: "Browser authorization page opened. Please approve access to continue.",
                              duration: 8
                            }));
                          }

                          session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output }, id: fc.id }] });
                        } catch (err: any) {
                          session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: err.message } }, id: fc.id }] });
                        }
                      })();
                    } else if (dynamicDesktopToolNames.has(fc.name)) {
                      // Desktop control tools: execute natively via Node.js Direct Soul Engine
                      (async () => {
                        console.log(`[Desktop Agent Native] Executing ${fc.name} via Node.js Direct Soul Engine...`);
                        const agentResult = await callDesktopAgent(fc.name, fc.args as Record<string, unknown>);

                        if (agentResult.ok) {
                          const output = agentResult.result ?? { result: "Done." };
                          if (fc.name === "show_desktop_notification") {
                            clientWs.send(JSON.stringify({
                              type: "notification",
                              title: (fc.args as any)?.title || "MEERA Alert",
                              message: (fc.args as any)?.message || (fc.args as any)?.text || (output as any)?.result || "",
                              duration: (fc.args as any)?.duration || 6
                            }));
                          }
                          if (fc.name === "take_screenshot" && (output as any)?.path) {
                            try {
                              const imgBytes = await fs.promises.readFile((output as any).path);
                              session.sendRealtimeInput({
                                video: { data: imgBytes.toString("base64"), mimeType: "image/png" }
                              });
                              console.log("[Vision] Forwarded screenshot directly into Gemini Live vision stream.");
                            } catch (e: any) {
                              console.warn("[Vision] Failed forwarding screenshot:", e?.message);
                            }
                          }
                          session.sendToolResponse({
                            functionResponses: [{
                              name: fc.name,
                              response: { output },
                              id: fc.id
                            }]
                          });
                        } else {
                          const errMsg = agentResult.error || "Desktop engine error.";
                          console.error(`[Desktop Agent Native] Error for ${fc.name}:`, errMsg);
                          session.sendToolResponse({
                            functionResponses: [{
                              name: fc.name,
                              response: {
                                output: {
                                  status: "error",
                                  error: errMsg,
                                  healing_advice: agentResult.healing_suggestion,
                                  healing_hints: agentResult.healing_hints,
                                  directive: "Self-healing protocol active: Diagnose this failure, adapt your approach, and try an alternative tool or dynamic script to fix the user's request."
                                }
                              },
                              id: fc.id
                            }]
                          });
                        }
                      })();
                    } else {
                      clientWs.send(JSON.stringify({
                        type: "toolCall",
                        callId: fc.id,
                        name: fc.name,
                        args: fc.args
                      }));
                    }
                  }
                }
              },
              onclose: () => {
                console.log("[Gemini Live] Session closed by upstream");
                if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
                  console.log("[Gemini Live] Client still active. Auto-reconnecting live session...");
                  scheduleReconnect(1500);
                } else {
                  clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
                }
              },
              onerror: (err: any) => {
                console.error("[Gemini Live] Upstream error:", err?.message || err);
                if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
                  scheduleReconnect(2000);
                }
              }
            }
          });

          // Edge Case Fix: If this was a mid-call reconnection, inject the dialogueHistory so far so Meera doesn't lose current context
          if (isReconnect && dialogueHistory.length > 0) {
            try {
              const recentHistory = dialogueHistory.slice(-8);
              const summaryText = recentHistory.map(h => `${h.role === "user" ? "User" : "Meera"}: ${h.text}`).join("\n");
              session.sendClientContent({
                turns: [{
                  role: "user",
                  parts: [{ text: `[System Session Resumed]: We had a brief network reconnection. Here is the immediate conversation so far:\n${summaryText}\nContinue smoothly without repeating yourself.` }]
                }],
                turnComplete: false
              });
            } catch (reconErr) {
              console.warn("[Gemini Live] Failed injecting resumed conversation context:", reconErr);
            }
          }

          activeSession = session;
          isReconnecting = false;
          reconnectionAttempts = 0;
          clientWs.send(JSON.stringify({ type: "status", status: "connected" }));

          // Warm Open-Loop Continuity Greeting (Proactive Initiative)
          if (!hasGreetedThisSession && !isReconnect) {
            if (greetingTimer) clearTimeout(greetingTimer);
          greetingTimer = setTimeout(async () => {
            if (
              activeSession &&
              !isClientClosed &&
              !isReconnecting &&
              clientWs.readyState === WebSocket.OPEN &&
              !isModelSpeaking &&
              Date.now() - lastUserActivity > 2500
            ) {
              try {
                hasGreetedThisSession = true;
                const latestEpisode = await dbGetLatestEpisode();
                const prompt = (latestEpisode && latestEpisode.summary)
                  ? `[System Event]: The user has just opened Meera. As their warm desktop companion, greet them in 1-2 friendly sentences. Naturally reference what you were working on last time: "${latestEpisode.title} (${latestEpisode.summary})". Ask if they'd like to continue with that or do something new.`
                  : `[System Event]: The user has just opened Meera. Greet them warmly and cheerfully in 1-2 friendly sentences, let them know you're ready, and ask what they would like to do today.`;

                console.log("[Proactive Initiative] Triggering warm open-loop session greeting...");
                clientWs.send(JSON.stringify({
                  type: "proactive_greeting",
                  title: latestEpisode?.title || "Welcome back"
                }));

                activeSession.sendClientContent({
                  turns: [{
                    role: "user",
                    parts: [{ text: prompt }]
                  }],
                  turnComplete: true
                });
              } catch (e: any) {
                console.warn("[Proactive Initiative] Greeting skipped or failed:", e?.message);
              }
            }
          }, 3000);
        }

          // Flush any audio queued while reconnecting
          while (pendingAudioQueue.length > 0) {
          const chunk = pendingAudioQueue.shift();
          if (chunk) {
            try {
              activeSession.sendRealtimeInput({
                audio: { data: chunk, mimeType: "audio/pcm;rate=16000" }
              });
            } catch { }
          }
        }
      } catch (err: any) {
        console.error("Error connecting to Gemini Live API:", err);
        // Reset resumption handle on error so next retry starts with clean session
        resumptionHandle = undefined;
        if (!isClientClosed && clientWs.readyState === WebSocket.OPEN) {
          scheduleReconnect(2000);
        } else {
          clientWs.send(JSON.stringify({
            type: "error",
            error: `Could not connect to Gemini: ${err.message || err}`
          }));
          clientWs.close();
        }
      }
    };

    await connectGeminiLive(false);

    // -----------------------------------------------------------------------
    // ObserverDaemon: Zero-Token Local Heuristic Watcher
    // Runs every 30 seconds to monitor local system health & session habits.
    // -----------------------------------------------------------------------
    const RAM_ALERT_COOLDOWN = 20 * 60 * 1000;   // 20 minutes
    const BREAK_ALERT_COOLDOWN = 90 * 60 * 1000; // 90 minutes
    const CONTINUOUS_WORK_THRESHOLD = 90 * 60 * 1000; // 90 minutes

    observerInterval = setInterval(async () => {
      try {
        if (
          isClientClosed ||
          isReconnecting ||
          !activeSession ||
          clientWs.readyState !== WebSocket.OPEN ||
          isModelSpeaking
        ) {
          return;
        }

        const now = Date.now();
        const idleTime = now - lastUserActivity;

        // Never interrupt the user while they are actively talking or interacting (< 4 seconds)
        if (idleTime < 4000) {
          return;
        }

        // Heuristic A: Critical High RAM Alert (>= 92% memory utilized)
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedPct = ((totalMem - freeMem) / totalMem) * 100;

        if (usedPct >= 92 && (now - lastRamAlert > RAM_ALERT_COOLDOWN)) {
          lastRamAlert = now;
          console.log(`[ObserverDaemon] High RAM usage detected: ${usedPct.toFixed(1)}%. Triggering proactive alert...`);

          clientWs.send(JSON.stringify({
            type: "proactive_alert",
            category: "system_ram",
            level: "warning",
            message: `System RAM is at ${usedPct.toFixed(0)}%.`
          }));

          activeSession.sendClientContent({
            turns: [{
              role: "user",
              parts: [{
                text: `[System Proactive Alert]: System RAM usage has reached ${usedPct.toFixed(0)}%. In a single, brief, caring sentence, let the user know memory is tight and ask if they'd like help checking or closing heavy background applications.`
              }]
            }],
            turnComplete: true
          });
          return;
        }

        // Heuristic B: Ergonomics & Continuous Session Break (after 90+ minutes of continuous activity)
        const sessionDuration = now - sessionStartTime;
        if (
          sessionDuration > CONTINUOUS_WORK_THRESHOLD &&
          (now - lastBreakAlert > BREAK_ALERT_COOLDOWN) &&
          idleTime > 15000 // User has paused for at least 15s (good natural break moment)
        ) {
          lastBreakAlert = now;
          console.log("[ObserverDaemon] Session duration threshold reached. Triggering ergonomic reminder...");

          clientWs.send(JSON.stringify({
            type: "proactive_alert",
            category: "ergonomics",
            message: "Time for a healthy posture check and water break."
          }));

          activeSession.sendClientContent({
            turns: [{
              role: "user",
              parts: [{
                text: `[System Proactive Alert]: The user has been working continuously for over an hour and a half. In a gentle, warm companion tone (1 short sentence), remind them to stretch, rest their eyes, or grab a glass of water.`
              }]
            }],
            turnComplete: true
          });
        }
      } catch (obsErr: any) {
        console.warn("[ObserverDaemon] Tick error:", obsErr?.message);
      }
    }, 30000);

    clientWs.on("message", (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg.toString());
        if (msg.audio) {
          lastUserActivity = Date.now();
          if (isReconnecting || !activeSession) {
            if (pendingAudioQueue.length < 50) {
              pendingAudioQueue.push(msg.audio);
            }
          } else {
            activeSession.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          }
        } else if (msg.type === "video" && msg.video) {
          lastUserActivity = Date.now();
          if (!isScreenSharingActive) {
            isScreenSharingActive = true;
            console.log("[Vision] Live screen sharing stream started.");
            if (activeSession && !isReconnecting) {
              try {
                activeSession.sendClientContent({
                  turns: [{
                    role: "user",
                    parts: [{
                      text: "[System Event]: The user has started Screen Sharing. You can now visually perceive their screen in real-time."
                    }]
                  }],
                  turnComplete: false
                });
              } catch { }
            }
          }

          if (screenShareWatchdog) clearTimeout(screenShareWatchdog);
          screenShareWatchdog = setTimeout(() => {
            if (isScreenSharingActive) {
              isScreenSharingActive = false;
              console.log("[Vision] Screen sharing stream ended (no frames for 4.5s).");
              if (activeSession && !isReconnecting && !isClientClosed) {
                try {
                  activeSession.sendClientContent({
                    turns: [{
                      role: "user",
                      parts: [{
                        text: "[System Event]: Screen sharing has stopped. You can NO LONGER see the user's screen. If asked to click any button, link, or text, call 'click_screen_element' directly (uses Windows Native OCR). If asked to describe general visuals or camera, remind the user to click Share Screen again."
                      }]
                    }],
                    turnComplete: false
                  });
                } catch { }
              }
            }
          }, 4500);

          if (activeSession && !isReconnecting) {
            activeSession.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" }
            });
          }
        } else if (msg.type === "toolResponse") {
          lastUserActivity = Date.now();
          if (activeSession) {
            activeSession.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id
                }
              ]
            });
          }
        }
      } catch (e) {
        console.error("Error editing/forwarding client frame message:", e);
      }
    });

    clientWs.on("close", () => {
      console.log("Client disconnected, closing Gemini session");
      isClientClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (greetingTimer) {
        clearTimeout(greetingTimer);
        greetingTimer = null;
      }
      if (observerInterval) {
        clearInterval(observerInterval);
        observerInterval = null;
      }
      if (screenShareWatchdog) {
        clearTimeout(screenShareWatchdog);
        screenShareWatchdog = null;
      }
      if (episodeDebounceTimer) {
        clearTimeout(episodeDebounceTimer);
        episodeDebounceTimer = null;
      }
      try {
        activeSession?.close();
      } catch (e) { }

      // Episodic Diary Consolidation: synthesize session episode if conversation has substance
      if (dialogueHistory.length >= 1) {
        synthesizeSessionEpisode(apiKey, dialogueHistory, sessionEpisodeId, sessionStartTimeIso)
          .then((ep) => {
            if (ep) {
              console.log(`[Session Diary] Recorded episode: "${ep.title}" (${ep.id})`);
            }
          })
          .catch((err) => {
            console.error("[Session Diary] Error recording episode:", err);
          })
          .finally(() => {
            flushToDiskSync();
          });
      }
    });

  } catch (err: any) {
    console.error("Error connecting to Gemini Live API:", err);
    clientWs.send(JSON.stringify({
      type: "error",
      error: `Could not connect to Gemini: ${err.message || err}`
    }));
    clientWs.close();
  }
});

// Serve custom static assets folder
app.use("/assets", express.static(path.join(process.cwd(), "assets")));

// API Status fallback for non-API web queries
app.get('*', (_req, res) => {
  res.json({ name: 'MEERA AI Companion', status: 'online' });
});

server.listen(PORT, "127.0.0.1", () => {
  logStartup(`MEERA V2 server started on http://127.0.0.1:${PORT}`);
  console.log(`[Server] Running on http://127.0.0.1:${PORT}`);
  console.log(`[Desktop Agent Native] 54 native desktop tools active with 0 ms bridge latency.`);
});

// Ensure database is safely and synchronously flushed to disk on shutdown
process.on("beforeExit", () => { flushToDiskSync(); });
process.on("exit", () => { flushToDiskSync(); });
process.on("SIGINT", () => { flushToDiskSync(); process.exit(0); });
process.on("SIGTERM", () => { flushToDiskSync(); process.exit(0); });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});

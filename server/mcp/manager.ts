import path from "path";
import fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import crossSpawn from "cross-spawn";
import readline from "readline";
import { getMcpConfigPath, getMcpCachePath, getWhatsAppDir, getMcpTokensDir } from "../server_paths";

type ServerConfig = { id: string; name?: string; enabled?: boolean; transport: "stdio" | "http" | "sse"; command?: string; args?: string[]; workingDirectory?: string; environment?: Record<string, string>; url?: string };
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class McpManager {
  private configs: ServerConfig[] = [];
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private pending = new Map<string, Pending>();
  private manuallyStopped = new Set<string>();
  private remoteUrls = new Map<string, string>();
  private sequence = 0;
  private toolMapping = new Map<string, { server: string; original: string }>();

  constructor(private root: string) {
    this.reload();
    this.loadCachedMappings();
  }

  private loadCachedMappings() {
    try {
      const cachedPath = getMcpCachePath();
      if (fs.existsSync(cachedPath)) {
        const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
        for (const t of cached) {
          if (t.name && t._mcpServer && t._mcpName) {
            this.toolMapping.set(t.name, { server: t._mcpServer, original: t._mcpName });
          }
        }
      }
    } catch {}
  }
  reload() { 
    try { 
      const configPath = getMcpConfigPath();
      this.configs = JSON.parse(fs.readFileSync(configPath, "utf8")).servers || []; 
    } catch { 
      this.configs = []; 
    } 
  }
  getConfigs() { this.reload(); return this.configs; }
  async reconcile() {
    this.reload();
    for (const [id] of this.processes) {
      const config = this.configs.find((item) => item.id === id);
      if (!config || config.enabled === false) await this.stop(id);
    }
    for (const config of this.configs.filter((item) => item.enabled !== false)) {
      if (!this.processes.has(config.id) && !this.manuallyStopped.has(config.id)) {
        try { await this.start(config.id); } catch (error) { console.warn(`[MCP] ${config.id}:`, (error as Error).message); }
      }
    }
    return this.configs;
  }

  private async rpc(id: string, method: string, params: any = {}) {
    const child = this.processes.get(id); if (!child) throw new Error(`MCP server '${id}' is not running.`);
    const requestId = String(++this.sequence);
    return new Promise<any>((resolve, reject) => {
      this.pending.set(`${id}:${requestId}`, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      // Media uploads can legitimately take longer than ordinary MCP calls.
      // Keep the process alive and allow WhatsApp up to two minutes to finish.
      setTimeout(() => { if (this.pending.delete(`${id}:${requestId}`)) reject(new Error(`MCP request timed out: ${method}`)); }, 300000);
    });
  }

  private async connect(config: ServerConfig) {
    if (config.transport === "http") {
      if (!config.url) throw new Error(`MCP server '${config.id}' has no URL.`);
      this.remoteUrls.set(config.id, config.url);
      const init = await this.remoteRpc(config.id, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "MEERA", version: "1.0.0" } });
      await this.remoteRpc(config.id, "notifications/initialized", {});
      const listed = await this.remoteRpc(config.id, "tools/list");
      return listed?.tools || init?.tools || [];
    }
    if (config.transport === "sse") {
      if (!config.url) throw new Error(`MCP server '${config.id}' has no URL.`);
      this.remoteUrls.set(config.id, config.url);
      const listed = await this.remoteRpc(config.id, "tools/list");
      return listed?.tools || [];
    }
    const command = process.platform === "win32" && config.command === "npx" ? "npx.cmd" : (config.command || "node");
    const isPackaged = Boolean(process.env.MEERA_LAUNCHED_BY === "electron" && process.execPath);
    const resolvedCommand = (command === "node" && isPackaged) ? process.execPath : command;

    // Self-Healing OAuth Token Store & Credential Invalidation:
    // If user changes their GOOGLE_CLIENT_ID or client credentials, automatically invalidate
    // stale cached tokens to avoid invalid_grant or authentication deadlock.
    const tokensDir = getMcpTokensDir();
    const serverEnv = { ...(config.environment || {}) };

    if (config.id === "gmail" || config.id === "google-drive") {
      const tokenFileName = config.id === "gmail" ? "gmail-token-store" : "drive-token-store";
      const tokenFilePath = path.join(tokensDir, tokenFileName);
      const clientId = serverEnv.GOOGLE_CLIENT_ID || "";
      const metaFilePath = path.join(tokensDir, `.${config.id}-client-meta.json`);

      // If user replaced placeholder or changed client credentials, wipe old token
      if (clientId && clientId !== "YOUR_GOOGLE_CLIENT_ID_HERE" && clientId !== "YOUR_GOOGLE_CLIENT_ID") {
        let prevClientId = "";
        try {
          if (fs.existsSync(metaFilePath)) {
            prevClientId = JSON.parse(fs.readFileSync(metaFilePath, "utf8")).client_id || "";
          }
        } catch {}

        if (prevClientId && prevClientId !== clientId) {
          console.log(`[MCP ${config.id}] Detected changed GOOGLE_CLIENT_ID. Purging stale auth token...`);
          try { fs.rmSync(tokenFilePath, { force: true, recursive: true }); } catch {}
        }
        try { fs.writeFileSync(metaFilePath, JSON.stringify({ client_id: clientId, updated_at: new Date().toISOString() }, null, 2), "utf8"); } catch {}
      }

      // Authoritative token store URI pointing to protected AppData vault
      const authoritativeUri = `file:///${tokenFilePath.replace(/\\/g, "/")}`;
      serverEnv.TOKEN_STORE_URI = authoritativeUri;
    }

    const env = Object.fromEntries(Object.entries({ 
      ...process.env, 
      MEERA_WHATSAPP_DIR: getWhatsAppDir(),
      ELECTRON_RUN_AS_NODE: (command === "node" && isPackaged) ? "1" : (process.env.ELECTRON_RUN_AS_NODE || "1"),
      ...serverEnv 
    }).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    const child = crossSpawn(resolvedCommand, (config.args || []).map(String), {
      cwd: path.resolve(this.root, config.workingDirectory || "."),
      env,
      windowsHide: true,
      shell: false
    }) as ChildProcessWithoutNullStreams;
    this.processes.set(config.id, child);
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) {
            const reqKey = `${config.id}:${msg.id}`;
            this.pending.get(reqKey)?.resolve(msg.result ?? msg.error);
            this.pending.delete(reqKey);
          }
        } catch {}
      }
    });
    child.on("exit", () => this.processes.delete(config.id));
    await this.rpc(config.id, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "MEERA", version: "1.0.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await this.rpc(config.id, "tools/list");
    return listed?.tools || [];
  }

  private async remoteRpc(id: string, method: string, params: any = {}) {
    const url = this.remoteUrls.get(id);
    if (!url) throw new Error(`MCP server '${id}' is not connected.`);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: String(++this.sequence), method, params }) });
    if (!response.ok) throw new Error(`Remote MCP ${response.status}: ${await response.text()}`);
    const body = await response.text();
    const data = body.startsWith("data:") ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("") : body;
    return JSON.parse(data || "{}").result;
  }

  async start(id: string) {
    this.reload();
    const config = this.configs.find((item) => item.id === id);
    if (!config) throw new Error(`MCP server '${id}' is not configured.`);
    if (config.enabled === false) return { running: false, disabled: true, message: `MCP server '${id}' is disabled in config/mcp-servers.json.` };
    this.manuallyStopped.delete(id);
    if (this.processes.has(id)) return { running: true };
    const tools = await this.connect(config);
    return { running: this.processes.has(id), tools };
  }

  async stop(id: string) {
    this.manuallyStopped.add(id);
    const child = this.processes.get(id);
    if (child) {
      try {
        if (process.platform === "win32" && child.pid) {
          await new Promise<void>((resolve) => {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
            killer.once("close", () => resolve());
            setTimeout(resolve, 5000);
          });
        }
        else child.kill("SIGTERM");
      } catch {}
      this.processes.delete(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    return { running: false };
  }
  status(id: string) {
    const child = this.processes.get(id);
    return { running: Boolean(child && !child.killed && child.exitCode === null), pid: child?.pid || null };
  }

  async discover() {
    this.reload();
    const enabledConfigs = this.configs.filter((s) => s.enabled !== false);
    const results = await Promise.allSettled(
      enabledConfigs.map(async (config) => {
        const serverTools = await this.connect(config);
        const mapped = serverTools.map((t: any) => {
          const geminiName = `mcp_${config.id}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
          this.toolMapping.set(geminiName, { server: config.id, original: t.name });
          return {
            ...t,
            name: geminiName,
            _mcpServer: config.id,
            _mcpName: t.name
          };
        });
        return mapped;
      })
    );
    const tools: any[] = [];
    for (const res of results) {
      if (res.status === "fulfilled" && Array.isArray(res.value)) {
        tools.push(...res.value);
      }
    }
    return tools;
  }
  private adaptArgs(id: string, original: string, args: any): any {
    const res = { ...(args || {}) };
    // Edge case: GitHub search_repositories requires a query string
    if (id === "github" && original === "search_repositories") {
      if (!res.query || typeof res.query !== "string" || !res.query.trim()) {
        res.query = "MEERA";
      }
    }
    // Edge case: Gmail message-search expects structured query or rawGmailQuery object
    if (id === "gmail" && original === "message-search") {
      if (res.query && typeof res.query === "string") {
        const trimmed = res.query.trim();
        if (!trimmed.startsWith("{")) {
          res.query = { rawGmailQuery: trimmed };
        } else {
          try {
            res.query = JSON.parse(trimmed);
          } catch {
            res.query = { rawGmailQuery: trimmed };
          }
        }
      } else if (!res.query) {
        res.query = { rawGmailQuery: "" };
      }
    }
    // Edge case: Google Drive files-search expects structured query or rawDriveQuery object
    if (id === "google-drive" && original === "files-search") {
      if (res.query && typeof res.query === "string") {
        const trimmed = res.query.trim();
        if (!trimmed.startsWith("{")) {
          res.query = { rawDriveQuery: trimmed };
        } else {
          try {
            res.query = JSON.parse(trimmed);
          } catch {
            res.query = { rawDriveQuery: trimmed };
          }
        }
      } else if (!res.query) {
        res.query = { rawDriveQuery: "trashed = false" };
      }
    }
    return res;
  }

  async call(tool: string, args: any) {
    const mapping = this.toolMapping.get(tool);
    const id = mapping ? mapping.server : tool.split("_")[1];
    const original = mapping ? mapping.original : tool.split("_").slice(2).join("_");
    const current = this.processes.get(id);
    if (id === "whatsapp" && original === "whatsapp_delink") {
      throw new Error("WhatsApp Delink is manual-only. Use the Delink button in MCP Server Hub.");
    }
    // Status tools are always read-only. Return the authoritative file state
    // before touching the child process, even if a stale process reference exists.
    if (original === "whatsapp_status" || original === "whatsapp_link_status") {
      const waDir = getWhatsAppDir();
      const statusPath = path.join(waDir, ".mcp-status.json");
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        // Validate PID if reported: if process died, the true state is 'stopped'
        if (status.pid && status.state !== "stopped" && status.state !== "unlinked") {
          try {
            process.kill(Number(status.pid), 0);
          } catch {
            status.state = "stopped";
            status.ready = false;
            status.qr_required = false;
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ state: status.state || "stopped", ready: status.state === "ready", qr_required: !!status.qr_required }) }] };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ state: "stopped", ready: false, qr_required: false }) }] };
      }
    }
    if (this.manuallyStopped.has(id)) {
      throw new Error(`MCP server '${id}' is stopped. Press Start before using its tools.`);
    }
    const adapted = this.adaptArgs(id, original, args);
    const normalizedArgs = JSON.parse(JSON.stringify(adapted || {}, (_key, value) => {
      if (typeof value !== "string") return value;
      return value.replace(/^([A-Za-z]):\\\1:\\+/i, "$1:\\");
    }));
    if (!current || current.killed || current.exitCode !== null) await this.start(id);
    // Do not restart the MCP for a tool-level error. Invalid file paths,
    // rejected recipients, and WhatsApp API errors must be returned to Gemini
    // without disturbing the authenticated session.
    return this.remoteUrls.has(id)
      ? await this.remoteRpc(id, "tools/call", { name: original, arguments: normalizedArgs })
      : await this.rpc(id, "tools/call", { name: original, arguments: normalizedArgs });
  }
}

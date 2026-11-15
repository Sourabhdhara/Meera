/**
 * MEERA — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets MEERA_DATA_DIR to a
 * writable folder under %APPDATA%\MEERA (or %APPDATA%\MYRAA), because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";

/** Writable per-user data directory. Defaults to %APPDATA%\MEERA. */
export const DATA_DIR: string =
  process.env.MEERA_DATA_DIR ||
  process.env.MYRAA_DATA_DIR ||
  (process.env.APPDATA ? path.join(process.env.APPDATA, "MEERA") : process.cwd());

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  const dir = process.env.MEERA_DATA_DIR || process.env.MYRAA_DATA_DIR || DATA_DIR;
  return path.join(dir, name);
}

/**
 * Returns the authoritative path to the writable mcp-servers.json configuration file.
 * If the file doesn't exist (e.g. fresh installation or new user), automatically creates
 * it populated with the clean default MCP template ready for their API keys.
 */
export function getMcpConfigPath(): string {
  const userConfigDir = path.join(DATA_DIR, "config");
  try { fs.mkdirSync(userConfigDir, { recursive: true }); } catch {}
  const targetConfig = path.join(userConfigDir, "mcp-servers.json");

  // If already exists in writable AppData, return it
  if (fs.existsSync(targetConfig)) {
    return targetConfig;
  }

  // Check if project root or package template exists
  const root = process.env.MEERA_APP_ROOT || process.cwd();
  const templateCandidates = [
    path.join(root, "config", "default-mcp-servers.json"),
    path.join(root, "config", "mcp-servers.json"),
    path.join(process.cwd(), "config", "mcp-servers.json")
  ];

  for (const cand of templateCandidates) {
    if (fs.existsSync(cand)) {
      try {
        fs.copyFileSync(cand, targetConfig);
        console.log(`[MCP Config] Initialized fresh mcp-servers.json from template at: ${targetConfig}`);
        return targetConfig;
      } catch (err) {
        console.warn("[MCP Config] Error copying template:", err);
      }
    }
  }

  // Default fallback template if no template file exists
  const defaultTemplate = {
    servers: [
      {
        id: "github",
        name: "GitHub",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        environment: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "YOUR_GITHUB_TOKEN_HERE"
        },
        features: ["repositories", "issues", "commits", "pull_requests"]
      },
      {
        id: "whatsapp",
        name: "WhatsApp",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: ["WhatsApp_MCP_New/server.mjs"],
        workingDirectory: ".",
        features: ["status", "tools", "logs", "link", "delink", "messages", "contacts", "groups", "files", "locations"]
      },
      {
        id: "youtube",
        name: "YouTube",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@kirbah/mcp-youtube"],
        environment: {
          YOUTUBE_API_KEY: "YOUR_YOUTUBE_API_KEY_HERE"
        },
        features: ["video_search", "transcripts", "channel_metadata"]
      },
      {
        id: "telegram",
        name: "Telegram",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "telegram-bot-mcp-server"],
        environment: {
          TELEGRAM_BOT_API_TOKEN: "YOUR_TELEGRAM_BOT_API_TOKEN_HERE"
        },
        features: ["messages", "channels", "notifications"]
      },
      {
        id: "gmail",
        name: "Gmail",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@mcp-z/mcp-gmail"],
        environment: {
          GOOGLE_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID",
          GOOGLE_CLIENT_SECRET: "YOUR_GOOGLE_CLIENT_SECRET",
          TOKEN_STORE_URI: `file:///${path.join(DATA_DIR, "gmail-token-store").replace(/\\/g, "/")}`
        },
        features: ["email_search", "unread_messages", "drafting"]
      },
      {
        id: "google-drive",
        name: "Google Drive",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@mcp-z/mcp-drive"],
        environment: {
          GOOGLE_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID",
          GOOGLE_CLIENT_SECRET: "YOUR_GOOGLE_CLIENT_SECRET",
          TOKEN_STORE_URI: `file:///${path.join(DATA_DIR, "drive-token-store").replace(/\\/g, "/")}`
        },
        features: ["file_search", "file_read", "file_list", "upload", "download", "folders"]
      }
    ]
  };

  try {
    fs.writeFileSync(targetConfig, JSON.stringify(defaultTemplate, null, 2), "utf8");
    console.log(`[MCP Config] Auto-generated fresh default mcp-servers.json at: ${targetConfig}`);
  } catch (err) {
    console.error("[MCP Config] Failed creating default template:", err);
  }

  return targetConfig;
}

// ---------------------------------------------------------------------------
// Gemini API key store (Unified in meera.db secrets table).
// ---------------------------------------------------------------------------
export {
  dbGetGeminiApiKey as getGeminiApiKey,
  dbSetGeminiApiKey as setGeminiApiKey,
  dbClearGeminiApiKey as clearGeminiApiKey,
  dbHasGeminiApiKey as hasGeminiApiKey,
} from "./server_db";

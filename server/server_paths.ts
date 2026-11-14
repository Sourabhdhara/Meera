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

// ---------------------------------------------------------------------------
// Gemini API key store (Unified in meera.db secrets table).
// ---------------------------------------------------------------------------
export {
  dbGetGeminiApiKey as getGeminiApiKey,
  dbSetGeminiApiKey as setGeminiApiKey,
  dbClearGeminiApiKey as clearGeminiApiKey,
  dbHasGeminiApiKey as hasGeminiApiKey,
} from "./server_db";

import initSqlJs, { Database } from "sql.js";
import fs from "fs";
import path from "path";
import { dataFile } from "./server_paths";
import { Memory, MemoryCategory, MemoryEpisode } from "./src/lib/memoryTypes";

export type DbRecoveryState = "NORMAL" | "RESTORED_FROM_BACKUP" | "FRESH_DB_CREATED";
export let dbRecoveryState: DbRecoveryState = "NORMAL";

function getDbPath(): string {
  return dataFile("meera.db");
}
let dbInstance: Database | null = null;
let initPromise: Promise<Database> | null = null;

// Debounced disk flush to maximize SQLite write performance without blocking
let saveTimer: NodeJS.Timeout | null = null;

export function flushToDiskSync(): void {
  if (!dbInstance) return;
  try {
    const dbPath = getDbPath();
    const targetDir = path.dirname(dbPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    // Keep the last known-good SQLite image before replacing the live file.
    // This makes a sudden power loss recoverable even if the next write is
    // interrupted or the live file is later zero-filled.
    if (fs.existsSync(dbPath)) {
      const backupPath = `${dbPath}.backup`;
      try {
        const existing = fs.readFileSync(dbPath);
        const header = Buffer.from("SQLite format 3\u0000", "ascii");
        if (existing.length >= 100 && existing.subarray(0, 16).equals(header)) {
          fs.copyFileSync(dbPath, backupPath);
        }
      } catch (backupErr) {
        console.warn("[SQLite] Could not refresh database backup:", backupErr);
      }
    }
    const tmpPath = `${dbPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, dbPath);
    // Also seed the backup on the first successful save, when no previous
    // live database existed yet.
    try { fs.copyFileSync(dbPath, `${dbPath}.backup`); } catch (backupErr) {
      console.warn("[SQLite] Could not write database backup:", backupErr);
    }
  } catch (err) {
    console.error("[SQLite] Error saving database to disk:", err);
  }
}

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushToDiskSync();
  }, 100);
}

/**
 * Initializes SQLite database connection, applies schema, and handles one-time migration.
 */
export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs();
    let db: Database;
    const dbPath = getDbPath();

    if (!fs.existsSync(dbPath)) {
      const legacyPath = path.join(process.env.APPDATA || "", "MYRAA", "meera.db");
      if (fs.existsSync(legacyPath) && path.resolve(legacyPath) !== path.resolve(dbPath)) {
        try {
          const targetDir = path.dirname(dbPath);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(legacyPath, dbPath);
          console.log(`[SQLite] Migrated database from legacy path: ${legacyPath}`);
        } catch (e) {
          console.warn("[SQLite] Could not copy legacy database:", e);
        }
      }
    }

    const backupPath = `${dbPath}.backup`;
    const isValidSqlite = (filePath: string): boolean => {
      try {
        const bytes = fs.readFileSync(filePath);
        const header = Buffer.from("SQLite format 3\u0000", "ascii");
        if (bytes.length < 100 || !bytes.subarray(0, 16).equals(header)) return false;
        const probe = new SQL.Database(bytes);
        const result = probe.exec("PRAGMA integrity_check;");
        probe.close();
        const status = result?.[0]?.values?.[0]?.[0];
        return status === "ok";
      } catch {
        return false;
      }
    };

    const liveDbUsable = fs.existsSync(dbPath) && isValidSqlite(dbPath);
    const backupDbUsable = fs.existsSync(backupPath) && isValidSqlite(backupPath);

    if (liveDbUsable) {
      db = new SQL.Database(fs.readFileSync(dbPath));
      dbRecoveryState = "NORMAL";
      console.log(`[SQLite] Opened database from ${dbPath}`);
    } else if (backupDbUsable) {
      // The live DB is bad, but the last known-good backup is usable: replace
      // the live file with the backup so all saved memories/settings return.
      try { fs.unlinkSync(dbPath); } catch {}
      fs.copyFileSync(backupPath, dbPath);
      db = new SQL.Database(fs.readFileSync(dbPath));
      dbRecoveryState = "RESTORED_FROM_BACKUP";
      console.warn(`[SQLite] Restored corrupted database from ${backupPath}`);
    } else {
      // Live DB and backup are missing or unusable (both corrupt or fresh setup).
      // Start clean; unified notification triggers: "Database is missing or corrupted. Fresh new database created."
      try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
      dbRecoveryState = "FRESH_DB_CREATED";
      console.warn("[SQLite] Database is missing or corrupted. Fresh new database initialized.");
      db = new SQL.Database();
    }

    // Apply schema
    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT,
        access_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        importance INTEGER DEFAULT 3
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_takeaways TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_created_at ON episodes(created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS core_directives (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        priority INTEGER DEFAULT 1,
        version INTEGER DEFAULT 1,
        directive TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_transcripts_session ON user_transcripts(session_id);
      CREATE INDEX IF NOT EXISTS idx_user_transcripts_created ON user_transcripts(created_at);

      CREATE TABLE IF NOT EXISTS meera_transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meera_transcripts_session ON meera_transcripts(session_id);
      CREATE INDEX IF NOT EXISTS idx_meera_transcripts_created ON meera_transcripts(created_at);
    `);

    // Ensure importance column exists for legacy databases
    try {
      db.run("ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 3;");
    } catch {}

    // Auto-seed/sync core directives from default_directives.json
    syncCoreDirectives(db);

    // Migrate secrets.json and old files if present
    migrateOldFiles(db);
    initSecrets(db);

    dbInstance = db;
    // Initial flush to ensure meera.db exists physically on disk
    flushToDiskSync();
    return db;
  })();

  return initPromise;
}

function migrateOldFiles(db: Database): void {
  const oldMemoryFile = dataFile("memories.json");
  const oldSettingsFile = dataFile("settings.json");

  // 1. Migrate old memories.json if present
  if (fs.existsSync(oldMemoryFile)) {
    try {
      const raw = fs.readFileSync(oldMemoryFile, "utf-8");
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        console.log(`[SQLite Migration] Importing ${list.length} memories from memories.json...`);
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO memories (id, category, text, embedding, access_count, created_at, updated_at, last_accessed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `);
        const now = new Date().toISOString();
        for (const item of list) {
          stmt.run([
            item.id || Math.random().toString(36).substring(2, 11),
            item.category || "identity",
            item.text || "",
            item.embedding ? JSON.stringify(item.embedding) : null,
            item.accessCount || 0,
            item.createdAt || now,
            item.updatedAt || now,
            item.lastAccessedAt || null
          ]);
        }
        stmt.free();
        console.log("[SQLite Migration] Successfully imported memories into SQLite.");
      }
      // Safely archive old file
      try {
        fs.renameSync(oldMemoryFile, `${oldMemoryFile}.migrated_backup`);
      } catch {}
    } catch (e) {
      console.warn("[SQLite Migration] Memory migration warning:", e);
    }
  }

  // 2. Migrate old settings.json if present
  if (fs.existsSync(oldSettingsFile)) {
    try {
      const raw = fs.readFileSync(oldSettingsFile, "utf-8");
      const settingsObj = JSON.parse(raw);
      if (settingsObj && typeof settingsObj === "object") {
        console.log(`[SQLite Migration] Importing settings from settings.json...`);
        const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?);`);
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(settingsObj)) {
          stmt.run([k, JSON.stringify(v), now]);
        }
        stmt.free();
        console.log("[SQLite Migration] Successfully imported settings into SQLite.");
      }
      try {
        fs.renameSync(oldSettingsFile, `${oldSettingsFile}.migrated_backup`);
      } catch {}
    } catch (e) {
      console.warn("[SQLite Migration] Settings migration warning:", e);
    }
  }

  // 3. Migrate old secrets.json if present
  const oldSecretsFile = dataFile("secrets.json");
  if (fs.existsSync(oldSecretsFile)) {
    try {
      let raw = fs.readFileSync(oldSecretsFile, "utf-8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const key = (parsed.geminiApiKey || "").trim();
        const isCleared = parsed.isCleared === true;
        const now = new Date().toISOString();
        if (key && !isCleared) {
          const stmt = db.prepare("INSERT OR REPLACE INTO secrets (key, value, updated_at) VALUES ('geminiApiKey', ?, ?);");
          stmt.run([key, now]);
          stmt.free();
          console.log("[SQLite Migration] Gemini API key migrated to SQLite secrets table.");
        }
      }
      // Archive old secrets file
      try {
        fs.renameSync(oldSecretsFile, `${oldSecretsFile}.migrated_backup`);
      } catch {
        fs.unlinkSync(oldSecretsFile);
      }
      console.log("[SQLite Migration] Successfully retired secrets.json.");
    } catch (e) {
      console.warn("[SQLite Migration] secrets.json migration notice:", e);
    }
  }
}

let cachedApiKey: string | undefined = undefined;
let isKeyInitialized = false;

function initSecrets(db: Database): void {
  try {
    const stmt = db.prepare("SELECT value FROM secrets WHERE key = 'geminiApiKey';");
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      cachedApiKey = (row.value || "").trim() || undefined;
    } else {
      cachedApiKey = undefined;
    }
    stmt.free();
  } catch {
    cachedApiKey = undefined;
  }
  isKeyInitialized = true;
}

export function dbGetGeminiApiKey(): string | undefined {
  if (isKeyInitialized) {
    return cachedApiKey;
  }
  return undefined;
}

export function dbHasGeminiApiKey(): boolean {
  return Boolean(dbGetGeminiApiKey());
}

export async function dbSetGeminiApiKey(key: string): Promise<void> {
  const trimmed = (key || "").trim();
  cachedApiKey = trimmed || undefined;
  isKeyInitialized = true;

  const db = await getDb();
  const now = new Date().toISOString();
  if (trimmed) {
    const stmt = db.prepare("INSERT OR REPLACE INTO secrets (key, value, updated_at) VALUES ('geminiApiKey', ?, ?);");
    stmt.run([trimmed, now]);
    stmt.free();
  } else {
    const stmt = db.prepare("DELETE FROM secrets WHERE key = 'geminiApiKey';");
    stmt.run();
    stmt.free();
  }
  flushToDiskSync();
}

export async function dbClearGeminiApiKey(): Promise<void> {
  await dbSetGeminiApiKey("");
}

// ---------------------------------------------------------------------------
// Memory Database Operations (SQL)
// ---------------------------------------------------------------------------

export async function dbGetAllMemories(): Promise<Memory[]> {
  const db = await getDb();
  const stmt = db.prepare("SELECT * FROM memories ORDER BY created_at ASC;");
  const memories: Memory[] = [];

  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    let embedding: number[] | undefined;
    if (row.embedding) {
      try {
        embedding = JSON.parse(row.embedding);
      } catch {}
    }
    memories.push({
      id: row.id,
      category: row.category as MemoryCategory,
      text: row.text,
      embedding,
      importance: typeof row.importance === "number" ? row.importance : 3,
      accessCount: row.access_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at || undefined,
    });
  }
  stmt.free();
  return memories;
}

export async function dbInsertMemory(mem: Memory): Promise<void> {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO memories (id, category, text, embedding, access_count, created_at, updated_at, last_accessed_at, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
  `);
  stmt.run([
    mem.id,
    mem.category,
    mem.text,
    mem.embedding ? JSON.stringify(mem.embedding) : null,
    mem.accessCount || 0,
    mem.createdAt || new Date().toISOString(),
    mem.updatedAt || new Date().toISOString(),
    mem.lastAccessedAt || null,
    typeof mem.importance === "number" ? mem.importance : 3
  ]);
  stmt.free();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Episodic Conversation Memory Operations (SQL)
// ---------------------------------------------------------------------------

export async function dbInsertEpisode(episode: MemoryEpisode): Promise<void> {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO episodes (id, title, summary, key_takeaways, created_at)
    VALUES (?, ?, ?, ?, ?);
  `);
  stmt.run([
    episode.id,
    episode.title,
    episode.summary,
    episode.keyTakeaways ? JSON.stringify(episode.keyTakeaways) : null,
    episode.createdAt || new Date().toISOString()
  ]);
  stmt.free();
  flushToDiskSync();
}

export async function dbDeleteEpisode(id: string): Promise<boolean> {
  const db = await getDb();
  const stmt = db.prepare("DELETE FROM episodes WHERE id = ?;");
  stmt.run([id]);
  stmt.free();
  flushToDiskSync();
  return true;
}

export async function dbInsertUserTranscript(sessionId: string, text: string): Promise<void> {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const db = await getDb();
  const stmt = db.prepare("INSERT INTO user_transcripts (session_id, text, created_at) VALUES (?, ?, ?);");
  stmt.run([sessionId, trimmed, new Date().toISOString()]);
  stmt.free();
  flushToDiskSync();
}

export async function dbInsertMeeraTranscript(sessionId: string, text: string): Promise<void> {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const db = await getDb();
  const stmt = db.prepare("INSERT INTO meera_transcripts (session_id, text, created_at) VALUES (?, ?, ?);");
  stmt.run([sessionId, trimmed, new Date().toISOString()]);
  stmt.free();
  flushToDiskSync();
}

export async function dbGetRecentDialogueTurns(limit: number = 20): Promise<Array<{ role: "user" | "meera"; text: string; createdAt: string }>> {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT 'user' as role, text, created_at FROM user_transcripts
    UNION ALL
    SELECT 'meera' as role, text, created_at FROM meera_transcripts
    ORDER BY created_at DESC LIMIT ?;
  `);
  stmt.bind([limit]);
  const turns: Array<{ role: "user" | "meera"; text: string; createdAt: string }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    turns.push({
      role: row.role as "user" | "meera",
      text: row.text,
      createdAt: row.created_at
    });
  }
  stmt.free();
  return turns.reverse();
}

export async function dbGetRecentEpisodes(limit: number = 5): Promise<MemoryEpisode[]> {
  const db = await getDb();
  const stmt = db.prepare("SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?;");
  stmt.bind([limit]);
  const episodes: MemoryEpisode[] = [];

  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    let keyTakeaways: string[] | undefined;
    if (row.key_takeaways) {
      try {
        keyTakeaways = JSON.parse(row.key_takeaways);
      } catch {}
    }
    episodes.push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      keyTakeaways,
      createdAt: row.created_at
    });
  }
  stmt.free();
  return episodes;
}

export async function dbGetLatestEpisode(): Promise<MemoryEpisode | null> {
  const recent = await dbGetRecentEpisodes(1);
  return recent.length > 0 ? recent[0] : null;
}

export async function dbSearchEpisodes(query: string, limit: number = 4): Promise<MemoryEpisode[]> {
  const q = (query || "").toLowerCase().trim();
  const episodes = await dbGetRecentEpisodes(30);
  if (!q) return episodes.slice(0, limit);

  const words = q.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return episodes.slice(0, limit);

  const scored = episodes.map(ep => {
    let score = 0;
    const hay = `${ep.title} ${ep.summary} ${(ep.keyTakeaways || []).join(" ")}`.toLowerCase();
    for (const w of words) {
      if (hay.includes(w)) score += 2;
    }
    if (hay.includes(q)) score += 5;
    return { ep, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.ep);
}

export async function dbDeleteMemory(id: string): Promise<boolean> {
  const db = await getDb();
  const check = db.prepare("SELECT id FROM memories WHERE id = ?;");
  check.bind([id]);
  const exists = check.step();
  check.free();

  if (!exists) return false;

  const stmt = db.prepare("DELETE FROM memories WHERE id = ?;");
  stmt.run([id]);
  stmt.free();
  scheduleSave();
  return true;
}

export async function dbTouchMemory(id: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?;", [now, id]);
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Settings Database Operations (SQL)
// ---------------------------------------------------------------------------

export async function dbGetAllSettings(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const stmt = db.prepare("SELECT key, value FROM settings;");
  const settings: Record<string, unknown> = {};

  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  stmt.free();
  return settings;
}

export async function dbSetSettingsPatch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const db = await getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?);");

  for (const [key, val] of Object.entries(patch)) {
    stmt.run([key, JSON.stringify(val), now]);
  }
  stmt.free();
  scheduleSave();

  return await dbGetAllSettings();
}

export async function dbRemoveObsoleteSettings(): Promise<void> {
  const db = await getDb();
  const theme = db.exec("SELECT value FROM settings WHERE key = 'theme' LIMIT 1");
  const characterTheme = db.exec("SELECT value FROM settings WHERE key = 'characterTheme' LIMIT 1");
  if (theme.length && theme[0].values.length && (!characterTheme.length || !characterTheme[0].values.length)) {
    const value = theme[0].values[0][0];
    const copy = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?);");
    copy.run(["characterTheme", value, new Date().toISOString()]);
    copy.free();
  }
  const stmt = db.prepare("DELETE FROM settings WHERE key IN ('wakeWordEnabled', 'wakePhrase', 'sensitivity', 'theme');");
  stmt.run();
  stmt.free();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Core Directives & Seed Management
// ---------------------------------------------------------------------------

function syncCoreDirectives(db: Database): void {
  try {
    const root = process.env.MEERA_APP_ROOT || process.cwd();
    const seedCandidates = [
      path.join(root, "server", "data", "default_directives.json"),
      path.join(root, "dist", "data", "default_directives.json"),
      path.join(__dirname, "data", "default_directives.json"),
      path.join(__dirname, "..", "server", "data", "default_directives.json"),
      path.join(process.cwd(), "server", "data", "default_directives.json")
    ];
    let seedFile = "";
    for (const cand of seedCandidates) {
      if (fs.existsSync(cand)) {
        seedFile = cand;
        break;
      }
    }
    if (!seedFile) {
      console.warn("[Core Directives] default_directives.json not found on disk; skipping seed.");
      return;
    }

    const raw = fs.readFileSync(seedFile, "utf-8");
    const directives = JSON.parse(raw);
    if (!Array.isArray(directives)) return;

    const now = new Date().toISOString();
    const activeIds = new Set<string>();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO core_directives (id, category, priority, version, directive, updated_at)
      VALUES (?, ?, ?, ?, ?, ?);
    `);

    for (const d of directives) {
      if (d.id && d.directive) {
        activeIds.add(d.id);
        stmt.run([
          d.id,
          d.category || "general",
          typeof d.priority === "number" ? d.priority : 1,
          typeof d.version === "number" ? d.version : 1,
          d.directive,
          now
        ]);
      }
    }
    stmt.free();

    // Clean up any stale directives that were removed from JSON
    if (activeIds.size > 0) {
      const allRows = db.prepare("SELECT id FROM core_directives;");
      const toDelete: string[] = [];
      while (allRows.step()) {
        const id = (allRows.getAsObject() as any).id;
        if (!activeIds.has(id)) toDelete.push(id);
      }
      allRows.free();
      if (toDelete.length > 0) {
        const delStmt = db.prepare("DELETE FROM core_directives WHERE id = ?;");
        for (const delId of toDelete) {
          delStmt.run([delId]);
        }
        delStmt.free();
        console.log(`[Core Directives] Purged ${toDelete.length} removed directives from database.`);
      }
    }

    scheduleSave();
    console.log(`[Core Directives] Successfully synced ${directives.length} directives into SQLite.`);
  } catch (err: any) {
    console.error("[Core Directives] Error syncing directives:", err?.message || err);
  }
}

export async function dbGetCoreDirectives(maxPriority: number = 2): Promise<string[]> {
  const db = await getDb();
  // Always ensure fresh sync from default_directives.json if updated
  syncCoreDirectives(db);
  const stmt = db.prepare("SELECT directive FROM core_directives WHERE priority <= ? ORDER BY priority ASC, id ASC;");
  stmt.bind([maxPriority]);
  const directives: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    if (row.directive) directives.push(row.directive);
  }
  stmt.free();
  return directives;
}

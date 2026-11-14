import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// FileEngine (Tier 1 Direct V8 File I/O Core)
// Provides safe, high-speed file operations, listing, search, and Recycle Bin.
// ---------------------------------------------------------------------------

export class FileEngine {
  public resolvePath(inputPath: string): string {
    let p = inputPath.trim();
    if (p.startsWith("~/") || p === "~") {
      p = path.join(os.homedir(), p.slice(1));
    } else if (p.startsWith("%") && p.includes("%", 1)) {
      const match = p.match(/^%([^%]+)%(.*)$/);
      if (match) {
        const envVal = process.env[match[1]] || "";
        p = path.join(envVal, match[2]);
      }
    }
    return path.resolve(p);
  }

  public async readText(targetPath: string, maxChars: number = 15000, startLine?: number, endLine?: number): Promise<{ ok: boolean; content?: string; path: string; totalLines?: number; truncated?: boolean; error?: string }> {
    const p = this.resolvePath(targetPath);
    try {
      const data = await fs.promises.readFile(p, "utf-8");
      const lines = data.split(/\r?\n/);
      const totalLines = lines.length;

      if (typeof startLine === "number" || typeof endLine === "number") {
        const s = Math.max(1, startLine || 1) - 1;
        const e = Math.min(totalLines, endLine || totalLines);
        const selected = lines.slice(s, e).map((line, idx) => `${s + idx + 1}: ${line}`).join("\n");
        return {
          ok: true,
          path: p,
          totalLines,
          truncated: false,
          content: selected
        };
      }

      const truncated = data.length > maxChars;
      return {
        ok: true,
        path: p,
        totalLines,
        truncated,
        content: truncated ? data.slice(0, maxChars) + "\n...[truncated]" : data
      };
    } catch (err: any) {
      return { ok: false, path: p, error: `Failed reading '${p}': ${err.message}` };
    }
  }

  public async editFileContent(targetPath: string, target: string, replacement: string): Promise<{ ok: boolean; path: string; replacements?: number; error?: string }> {
    const p = this.resolvePath(targetPath);
    try {
      if (!fs.existsSync(p)) {
        return { ok: false, path: p, error: `File not found: '${p}'` };
      }
      const data = await fs.promises.readFile(p, "utf-8");
      if (!data.includes(target)) {
        return { ok: false, path: p, error: `Target snippet not found in file. Make sure target matches exact indentation and whitespace.` };
      }
      // Count occurrences
      let count = 0;
      let pos = 0;
      while ((pos = data.indexOf(target, pos)) !== -1) {
        count++;
        pos += target.length;
      }
      const updated = data.split(target).join(replacement);
      await fs.promises.writeFile(p, updated, "utf-8");
      return { ok: true, path: p, replacements: count };
    } catch (err: any) {
      return { ok: false, path: p, error: `Failed editing '${p}': ${err.message}` };
    }
  }

  public async searchCodebase(query: string, searchDir: string = ".", maxResults: number = 30): Promise<{ ok: boolean; matches: Array<{ file: string; line: number; text: string }>; count: number; error?: string }> {
    const rootDir = this.resolvePath(searchDir);
    const matches: Array<{ file: string; line: number; text: string }> = [];

    const ignoreDirs = new Set(["node_modules", ".git", "dist", ".next", "build", ".venv", "venv", "__pycache__"]);

    const walk = async (dir: string) => {
      if (matches.length >= maxResults) return;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxResults) break;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!ignoreDirs.has(entry.name)) {
              await walk(fullPath);
            }
          } else if (entry.isFile()) {
            // Check file size (< 2MB to prevent lockup)
            try {
              const stat = await fs.promises.stat(fullPath);
              if (stat.size > 2 * 1024 * 1024) continue;
              const content = await fs.promises.readFile(fullPath, "utf-8");
              if (content.toLowerCase().includes(query.toLowerCase())) {
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                    matches.push({
                      file: path.relative(rootDir, fullPath),
                      line: i + 1,
                      text: lines[i].trim().slice(0, 160)
                    });
                    if (matches.length >= maxResults) break;
                  }
                }
              }
            } catch {
              // Ignore binary or unreadable files
            }
          }
        }
      } catch (err: any) {
        // Skip inaccessible dirs
      }
    };

    try {
      await walk(rootDir);
      return { ok: true, matches, count: matches.length };
    } catch (err: any) {
      return { ok: false, matches: [], count: 0, error: err.message };
    }
  }

  public async writeText(targetPath: string, content: string): Promise<{ ok: boolean; path: string; result?: string; error?: string }> {
    const p = this.resolvePath(targetPath);
    try {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, content, "utf-8");
      return { ok: true, path: p, result: `Successfully wrote ${content.length} characters to '${path.basename(p)}'.` };
    } catch (err: any) {
      return { ok: false, path: p, error: `Failed writing to '${p}': ${err.message}` };
    }
  }

  public async appendText(targetPath: string, content: string, withTimestamp: boolean = true): Promise<{ ok: boolean; path: string; result?: string; error?: string }> {
    const p = this.resolvePath(targetPath);
    const ts = withTimestamp ? `\n[${new Date().toISOString().replace("T", " ").substring(0, 19)}] ` : "\n";
    const line = `${ts}${content}\n`;
    try {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.appendFile(p, line, "utf-8");
      return { ok: true, path: p, result: `Successfully appended note to '${path.basename(p)}'.` };
    } catch (err: any) {
      return { ok: false, path: p, error: `Failed appending to '${p}': ${err.message}` };
    }
  }

  public async listDir(folderPath: string = "~/Desktop"): Promise<{ ok: boolean; directory: string; count: number; entries: any[]; error?: string }> {
    const p = this.resolvePath(folderPath);
    try {
      const dirents = await fs.promises.readdir(p, { withFileTypes: true });
      const entries = dirents.map(d => ({
        name: d.name,
        type: d.isDirectory() ? "directory" : "file"
      }));
      return { ok: true, directory: p, count: entries.length, entries: entries.slice(0, 100) };
    } catch (err: any) {
      return { ok: false, directory: p, count: 0, entries: [], error: `Failed listing folder '${p}': ${err.message}` };
    }
  }

  public async search(query: string, searchDir: string = "~"): Promise<{ ok: boolean; count: number; matches: string[]; error?: string }> {
    const root = this.resolvePath(searchDir);
    const q = query.toLowerCase().trim();
    const matches: string[] = [];

    const scan = async (dir: string, depth: number) => {
      if (depth > 4 || matches.length >= 50) return;
      try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const item of list) {
          if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "AppData") continue;
          const full = path.join(dir, item.name);
          if (item.name.toLowerCase().includes(q)) {
            matches.push(full);
          }
          if (item.isDirectory()) {
            await scan(full, depth + 1);
          }
        }
      } catch {}
    };

    await scan(root, 0);
    return { ok: true, count: matches.length, matches };
  }

  public safeDelete(targetPath: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const p = this.resolvePath(targetPath);
    if (!fs.existsSync(p)) return Promise.resolve({ ok: false, error: `Path does not exist: '${p}'` });

    return new Promise((resolve) => {
      const ps = `
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("${p.replace(/\\/g, "\\\\")}", 'OnlyErrorDialogs', 'SendToRecycleBin')
      `;
      const encoded = Buffer.from(ps, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true, result: `Safely moved '${path.basename(p)}' to the Windows Recycle Bin.` });
        } else {
          resolve({ ok: false, error: "Failed to move file to Recycle Bin." });
        }
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
    });
  }

  public writeToNotepad(content: string, title: string = "Conversation"): { ok: boolean; result: string; path: string } {
    const safeTitle = title.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const tmp = path.join(os.tmpdir(), `${safeTitle}.txt`);
    fs.writeFileSync(tmp, content, "utf-8");
    spawn("notepad.exe", [tmp], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path: tmp, result: `Wrote content to temporary file ${path.basename(tmp)} and opened in Notepad.` };
  }

  public async readDocumentText(targetPath: string, maxCharacters: number = 25000): Promise<{ ok: boolean; text?: string; format?: string; pages?: number; error?: string }> {
    const p = this.resolvePath(targetPath);
    if (!fs.existsSync(p)) {
      return { ok: false, error: `Document file not found: '${p}'` };
    }

    const ext = path.extname(p).toLowerCase();

    try {
      if (ext === ".pdf") {
        // Dynamic import / require of pdf-parse
        const pdfParseMod = await import("pdf-parse");
        const pdfParse = (pdfParseMod as any).default || pdfParseMod;
        const dataBuffer = await fs.promises.readFile(p);
        const data = await pdfParse(dataBuffer);
        const text = data.text ? data.text.trim() : "";
        const truncated = text.length > maxCharacters;
        return {
          ok: true,
          format: "pdf",
          pages: data.numpages,
          text: truncated ? text.slice(0, maxCharacters) + "\n...[truncated]" : text
        };
      }

      if (ext === ".docx") {
        // Dynamic import / require of mammoth
        const mammothMod = await import("mammoth");
        const mammoth = (mammothMod as any).default || mammothMod;
        const result = await mammoth.extractRawText({ path: p });
        const text = result.value ? result.value.trim() : "";
        const truncated = text.length > maxCharacters;
        return {
          ok: true,
          format: "docx",
          text: truncated ? text.slice(0, maxCharacters) + "\n...[truncated]" : text
        };
      }

      if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".csv" || ext === ".log" || ext === ".html") {
        const data = await fs.promises.readFile(p, "utf-8");
        const truncated = data.length > maxCharacters;
        return {
          ok: true,
          format: ext.slice(1),
          text: truncated ? data.slice(0, maxCharacters) + "\n...[truncated]" : data
        };
      }

      return {
        ok: false,
        error: `Unsupported document format '${ext}'. Supported formats: .pdf, .docx, .txt, .md, .csv, .json, .png, .jpg (for images use find_text_in_image or read_document).`
      };
    } catch (err: any) {
      return { ok: false, error: `Failed parsing document '${path.basename(p)}': ${err.message}` };
    }
  }
}


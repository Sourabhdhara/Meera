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

  public async readText(targetPath: string, maxChars: number = 15000): Promise<{ ok: boolean; content?: string; path: string; truncated?: boolean; error?: string }> {
    const p = this.resolvePath(targetPath);
    try {
      const data = await fs.promises.readFile(p, "utf-8");
      const truncated = data.length > maxChars;
      return {
        ok: true,
        path: p,
        truncated,
        content: truncated ? data.slice(0, maxChars) + "\n...[truncated]" : data
      };
    } catch (err: any) {
      return { ok: false, path: p, error: `Failed reading '${p}': ${err.message}` };
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
}


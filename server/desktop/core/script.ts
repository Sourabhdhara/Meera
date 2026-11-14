import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, exec } from "child_process";

// ---------------------------------------------------------------------------
// Workspace Detection Helper
// ---------------------------------------------------------------------------
function getWorkspaceRoot(): string {
  if (process.env.MEERA_APP_ROOT && fs.existsSync(process.env.MEERA_APP_ROOT)) {
    return process.env.MEERA_APP_ROOT;
  }
  if (fs.existsSync(path.join(process.cwd(), "package.json"))) {
    return process.cwd();
  }
  let curr = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(curr, "package.json"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return process.cwd();
}

// Safety blacklist of self-destructive patterns
const BLOCKED_PATTERNS = [
  "format c:",
  "format d:",
  "rmdir /s /q c:\\windows",
  "del /f /s /q c:\\windows",
  ":(){ :|:& };:", // fork bomb
];

// ---------------------------------------------------------------------------
// ScriptEngine (Tier 2-3 Code & Persistent Automation Script Core)
// Executes dynamic PowerShell, CMD, and manages persistent library.
// ---------------------------------------------------------------------------

export class ScriptEngine {
  private workspaceRoot: string;
  private workingDirectory: string;
  private automationsDir: string;
  private manifestFile: string;

  constructor() {
    this.workspaceRoot = getWorkspaceRoot();
    this.workingDirectory = this.workspaceRoot;
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    this.automationsDir = path.join(appData, "MEERA", "scripts");
    if (!fs.existsSync(this.automationsDir)) {
      fs.mkdirSync(this.automationsDir, { recursive: true });
    }
    this.manifestFile = path.join(this.automationsDir, "manifest.json");
  }

  private checkSafety(scriptText: string): string | null {
    const lower = scriptText.toLowerCase();
    for (const pattern of BLOCKED_PATTERNS) {
      if (lower.includes(pattern)) {
        return `Execution blocked: forbidden dangerous command detected ('${pattern}').`;
      }
    }
    return null;
  }

  private rememberDirectoryChange(scriptText: string): void {
    const re = /(?:Set-Location|cd|chdir|sl)\s+(?:-LiteralPath\s+|-Path\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/ig;
    let match: RegExpExecArray | null;
    while ((match = re.exec(scriptText)) !== null) {
      const requested = match[1] || match[2] || match[3];
      if (!requested || requested.startsWith("$")) continue;
      const candidate = path.resolve(this.workingDirectory, requested);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) this.workingDirectory = candidate;
    }
  }

  public checkSafetyForVisibleExecution(scriptText: string): string | null {
    return this.checkSafety(scriptText);
  }

  public runPowerShellVisible(script: string): Promise<{ ok: boolean; stderr: string; result: string; output?: string; pid?: number }> {
    const safetyErr = this.checkSafety(script);
    if (safetyErr) return Promise.resolve({ ok: false, stderr: safetyErr, result: safetyErr });
    this.rememberDirectoryChange(script);
    const outputFile = path.join(os.tmpdir(), `meera-powershell-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const marker = `__MEERA_SCRIPT_COMPLETE_${Date.now()}__`;
    const escapedOutput = outputFile.replace(/'/g, "''");
    const escapedMarker = marker.replace(/'/g, "''");
    const wrapper = `& {\r\n${script}\r\n} *>&1 | Tee-Object -FilePath '${escapedOutput}'\r\nAdd-Content -Path '${escapedOutput}' -Value '${escapedMarker}'\r\nRead-Host 'MEERA: press Enter to close this PowerShell window'`;
    const wrapperFile = path.join(os.tmpdir(), `meera-powershell-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
    fs.writeFileSync(wrapperFile, wrapper, "utf8");
    return new Promise((resolve) => {
      try {
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", wrapperFile], {
          windowsHide: false,
          detached: true,
          stdio: "ignore",
          cwd: this.workingDirectory
        });
        child.unref();
        const startedAt = Date.now();
        const check = () => {
          let output = "";
          try { output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : ""; } catch {}
          if (output.includes(marker)) {
            const cleanOutput = output.replace(marker, "").trim();
            try { fs.unlinkSync(wrapperFile); } catch {}
            resolve({ ok: true, stderr: "", result: cleanOutput || "Visible PowerShell script completed.", output: cleanOutput, pid: child.pid });
            return;
          }
          if (Date.now() - startedAt > 600000) {
            resolve({ ok: false, stderr: "Visible PowerShell script did not finish within 600 seconds.", result: "Timed out waiting for visible PowerShell output.", pid: child.pid });
            return;
          }
          setTimeout(check, 250);
        };
        setTimeout(check, 300);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ ok: false, stderr: message, result: message });
      }
    });
  }

  public runCommand(command: string, timeoutSeconds: number = 15): Promise<{ ok: boolean; stdout: string; stderr: string; returncode: number; result: string }> {
    const safetyErr = this.checkSafety(command);
    if (safetyErr) {
      return Promise.resolve({ ok: false, stdout: "", stderr: safetyErr, returncode: -1, result: safetyErr });
    }

    return new Promise((resolve) => {
      exec(command, { timeout: timeoutSeconds * 1000, cwd: this.workingDirectory }, (err, stdout, stderr) => {
        if (!err) this.rememberDirectoryChange(command);
        const out = (stdout || "").trim();
        const errOut = (stderr || "").trim();
        resolve({
          ok: !err,
          stdout: out,
          stderr: errOut,
          returncode: typeof err?.code === "number" ? err.code : (err ? 1 : 0),
          result: out || (errOut ? `Error: ${errOut}` : "Command completed with zero output.")
        });
      });
    });
  }

  public runPowerShell(script: string, timeoutSeconds: number = 60): Promise<{ ok: boolean; stdout: string; stderr: string; returncode: number; result: string; running_time_ms?: number }> {
    const safetyErr = this.checkSafety(script);
    if (safetyErr) {
      return Promise.resolve({ ok: false, stdout: "", stderr: safetyErr, returncode: -1, result: safetyErr });
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      // Prepend ProgressPreference silencing to avoid CLIXML progress noise in stderr
      const cleanScript = `$ProgressPreference = 'SilentlyContinue';\r\n` + script;
      const encoded = Buffer.from(cleanScript, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.workingDirectory
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        const elapsed = Date.now() - startTime;
        resolve({
          ok: false,
          stdout,
          stderr: `Command did not complete within the requested ${timeoutSeconds}s budget and was cancelled.`,
          returncode: -1,
          result: `Timed out after ${(elapsed / 1000).toFixed(1)}s. Cancelled.`,
          running_time_ms: elapsed
        });
      }, timeoutSeconds * 1000);

      child.stdout.on("data", d => { stdout += d.toString(); });
      child.stderr.on("data", d => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        const out = stdout.trim();
        const cleanErr = stderr.replace(/#<\s*CLIXML[\s\S]*?<\/Objs>/gi, "").trim();
        const success = code === 0 || (code === null && out.length > 0);
        if (success) this.rememberDirectoryChange(script);
        resolve({
          ok: success,
          stdout: out,
          stderr: cleanErr,
          returncode: code ?? 0,
          result: out || cleanErr || "Script executed.",
          running_time_ms: elapsed
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message, returncode: -1, result: err.message });
      });
    });
  }

  public async saveAutomation(name: string, code: string, language: string = "powershell", description: string = ""): Promise<{ ok: boolean; file: string; result: string }> {
    const cleanName = name.trim().toLowerCase().replace(/[\s\-]/g, "_");
    const lang = language.toLowerCase().trim();
    const ext = lang === "cmd" || lang === "batch" ? ".bat" : ".ps1";
    const filePath = path.join(this.automationsDir, `${cleanName}${ext}`);

    await fs.promises.writeFile(filePath, code, "utf-8");

    let manifest: Record<string, any> = {};
    if (fs.existsSync(this.manifestFile)) {
      try {
        manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, "utf-8"));
      } catch {}
    }

    manifest[cleanName] = {
      name: cleanName,
      file: path.basename(filePath),
      language: lang === "cmd" || lang === "batch" ? "cmd" : "powershell",
      description: description || `${lang.toUpperCase()} automation script`,
      updated_at: new Date().toISOString()
    };
    await fs.promises.writeFile(this.manifestFile, JSON.stringify(manifest, null, 2), "utf-8");

    return { ok: true, file: filePath, result: `Saved automation script '${cleanName}' (${lang}).` };
  }

  public async runAutomation(name: string, timeoutSeconds: number = 30): Promise<{ ok: boolean; stdout: string; returncode: number; result: string; stderr?: string }> {
    const cleanName = name.trim().toLowerCase().replace(/[\s\-]/g, "_");
    let targetFile = "";

    if (fs.existsSync(this.manifestFile)) {
      try {
        const manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, "utf-8"));
        if (manifest[cleanName]?.file) {
          targetFile = path.join(this.automationsDir, manifest[cleanName].file);
        }
      } catch {}
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      for (const ext of [".ps1", ".bat", ".cmd"]) {
        const cand = path.join(this.automationsDir, `${cleanName}${ext}`);
        if (fs.existsSync(cand)) {
          targetFile = cand;
          break;
        }
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      return { ok: false, stdout: "", stderr: `Automation script '${name}' not found.`, returncode: -1, result: `Automation script '${name}' not found.` };
    }

    const ext = path.extname(targetFile).toLowerCase();
    if (ext === ".ps1") {
      const res = await this.runPowerShell(`& "${targetFile.replace(/\\/g, "\\\\")}"`, timeoutSeconds);
      return { ok: res.ok, stdout: res.stdout, stderr: res.stderr, returncode: res.returncode, result: res.result };
    }

    return new Promise((resolve) => {
      exec(`"${targetFile}"`, { timeout: timeoutSeconds * 1000, cwd: this.workspaceRoot }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout?.trim() || "",
          returncode: typeof err?.code === "number" ? err.code : (err ? 1 : 0),
          result: stdout?.trim() || stderr?.trim() || `Executed automation script '${name}'.`
        });
      });
    });
  }

  public async listAutomations(): Promise<{ ok: boolean; count: number; automations: any[]; result: any[] }> {
    if (!fs.existsSync(this.manifestFile)) {
      return { ok: true, count: 0, automations: [], result: [] };
    }
    try {
      const manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, "utf-8"));
      const list = Object.values(manifest);
      return { ok: true, count: list.length, automations: list, result: list };
    } catch {
      return { ok: true, count: 0, automations: [], result: [] };
    }
  }

  public async deleteAutomation(name: string): Promise<{ ok: boolean; result: string }> {
    const cleanName = name.trim().toLowerCase().replace(/[\s\-]/g, "_");
    let fileToDelete = "";

    if (fs.existsSync(this.manifestFile)) {
      const manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, "utf-8"));
      if (manifest[cleanName]) {
        fileToDelete = manifest[cleanName].file;
        delete manifest[cleanName];
        await fs.promises.writeFile(this.manifestFile, JSON.stringify(manifest, null, 2), "utf-8");
      }
    }

    if (fileToDelete) {
      const fp = path.join(this.automationsDir, fileToDelete);
      if (fs.existsSync(fp)) await fs.promises.unlink(fp);
    }
    return { ok: true, result: `Successfully deleted automation script '${name}'.` };
  }
}


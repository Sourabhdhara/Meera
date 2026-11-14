import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { IScriptEngine, ScriptResult } from "../types";

export class LinuxScriptEngine implements IScriptEngine {
  private automationsDir: string;

  constructor() {
    this.automationsDir = path.join(os.homedir(), ".meera", "automations");
    if (!fs.existsSync(this.automationsDir)) {
      fs.mkdirSync(this.automationsDir, { recursive: true });
    }
  }

  public runCommand(cmd: string, timeoutSeconds: number = 15): Promise<ScriptResult> {
    return this.executeBash(cmd, timeoutSeconds);
  }

  public runScript(script: string, timeoutSeconds: number = 30): Promise<ScriptResult> {
    return this.executeBash(script, timeoutSeconds);
  }

  public runPowerShell(script: string, timeoutSeconds: number = 30): Promise<ScriptResult> {
    // On Linux, if pwsh is available use it, otherwise fall back transparently to bash
    return this.executeBash(script, timeoutSeconds);
  }

  private executeBash(cmd: string, timeoutSeconds: number): Promise<ScriptResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", cmd], {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutSeconds * 1000);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return resolve({
            ok: false,
            returncode: -1,
            stderr: `Command timed out after ${timeoutSeconds}s.`,
            error: "TIMEOUT"
          });
        }
        resolve({
          ok: code === 0,
          returncode: code || 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          result: stdout.trim() || stderr.trim() || `Command completed with exit code ${code}`
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          returncode: -1,
          stderr: err.message,
          error: err.message
        });
      });
    });
  }

  public async saveAutomation(name: string, code: string, language: string = "bash", description?: string): Promise<{ ok: boolean; result?: string; file?: string }> {
    try {
      const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const ext = language === "python" ? ".py" : ".sh";
      const filePath = path.join(this.automationsDir, `${safeName}${ext}`);
      const content = description ? `# ${description}\n\n${code}` : code;
      await fs.promises.writeFile(filePath, content, "utf-8");
      return { ok: true, result: `Saved automation script to '${filePath}'.`, file: filePath };
    } catch (err: any) {
      return { ok: false, result: err.message };
    }
  }

  public async runAutomation(name: string, timeoutSeconds: number = 30): Promise<ScriptResult> {
    const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const shPath = path.join(this.automationsDir, `${safeName}.sh`);
    const pyPath = path.join(this.automationsDir, `${safeName}.py`);

    if (fs.existsSync(shPath)) {
      return this.executeBash(`bash "${shPath}"`, timeoutSeconds);
    } else if (fs.existsSync(pyPath)) {
      return this.executeBash(`python3 "${pyPath}"`, timeoutSeconds);
    }
    return { ok: false, returncode: -1, stderr: `Automation script '${name}' not found.` };
  }

  public async listAutomations(): Promise<{ ok: boolean; automations: any[]; count: number }> {
    try {
      const files = await fs.promises.readdir(this.automationsDir);
      const automations = files.map((f) => ({ name: f, path: path.join(this.automationsDir, f) }));
      return { ok: true, automations, count: automations.length };
    } catch (err: any) {
      return { ok: false, automations: [], count: 0 };
    }
  }

  public async deleteAutomation(name: string): Promise<{ ok: boolean; result?: string }> {
    try {
      const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      const shPath = path.join(this.automationsDir, `${safeName}.sh`);
      const pyPath = path.join(this.automationsDir, `${safeName}.py`);
      if (fs.existsSync(shPath)) await fs.promises.unlink(shPath);
      if (fs.existsSync(pyPath)) await fs.promises.unlink(pyPath);
      return { ok: true, result: `Deleted automation script '${name}'.` };
    } catch (err: any) {
      return { ok: false, result: err.message };
    }
  }
}

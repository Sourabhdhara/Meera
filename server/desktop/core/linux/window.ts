import { exec } from "child_process";
import { promisify } from "util";
import { IWindowEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxWindowEngine implements IWindowEngine {
  public async listWindows(): Promise<{ ok: boolean; windows: Array<{ pid: number; title: string; handle?: string | number }> }> {
    try {
      // wmctrl lists window ID, desktop, client machine, PID, title
      const { stdout } = await execAsync("wmctrl -l -p -x");
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const windows: Array<{ pid: number; title: string; handle?: string }> = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const handle = parts[0];
          const pid = parseInt(parts[2], 10) || 0;
          const title = parts.slice(4).join(" ");
          windows.push({ pid, title, handle });
        }
      }
      return { ok: true, windows };
    } catch {
      return { ok: false, windows: [] };
    }
  }

  public async focusWindow(query: string): Promise<{ ok: boolean; result: string; title?: string }> {
    try {
      // Try wmctrl first by title substring
      await execAsync(`wmctrl -a "${query.replace(/"/g, '\\"')}"`);
      return { ok: true, result: `Brought window matching '${query}' to the foreground.`, title: query };
    } catch {
      // Fallback using xdotool
      try {
        await execAsync(`xdotool search --name "${query.replace(/"/g, '\\"')}" windowactivate`);
        return { ok: true, result: `Activated window matching '${query}'.`, title: query };
      } catch (err: any) {
        return { ok: false, result: `Could not find open window matching '${query}': ${err.message}` };
      }
    }
  }

  public async minimizeWindow(query: string): Promise<{ ok: boolean; result: string }> {
    try {
      await execAsync(`xdotool search --name "${query.replace(/"/g, '\\"')}" windowminimize`);
      return { ok: true, result: `Minimized window matching '${query}'.` };
    } catch (err: any) {
      return { ok: false, result: err.message };
    }
  }

  public async maximizeWindow(query: string): Promise<{ ok: boolean; result: string }> {
    try {
      await execAsync(`wmctrl -r "${query.replace(/"/g, '\\"')}" -b add,maximized_vert,maximized_horz`);
      return { ok: true, result: `Maximized window matching '${query}'.` };
    } catch (err: any) {
      return { ok: false, result: err.message };
    }
  }

  public async closeWindow(query: string): Promise<{ ok: boolean; result: string }> {
    try {
      await execAsync(`wmctrl -c "${query.replace(/"/g, '\\"')}"`);
      return { ok: true, result: `Closed window matching '${query}'.` };
    } catch (err: any) {
      return { ok: false, result: err.message };
    }
  }

  public async getActiveWindow(): Promise<{ ok: boolean; title: string; pid: number }> {
    try {
      const { stdout } = await execAsync("xdotool getactivewindow getwindowname");
      const title = stdout.trim();
      let pid = 0;
      try {
        const pidRes = await execAsync("xdotool getactivewindow getwindowpid");
        pid = parseInt(pidRes.stdout.trim(), 10) || 0;
      } catch { }
      return { ok: true, title, pid };
    } catch (err: any) {
      return { ok: false, title: "Desktop", pid: 0 };
    }
  }
}

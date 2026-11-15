import { exec } from "child_process";
import { promisify } from "util";
import { IUIAEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxUIAEngine implements IUIAEngine {
  public async getForegroundElements(): Promise<{ ok: boolean; elements: any[]; count: number; error?: string }> {
    try {
      // Get active window title and coordinates via xdotool
      const { stdout } = await execAsync("xdotool getactivewindow getwindowgeometry --shell 2>/dev/null");
      const geom: Record<string, number> = {};
      stdout.split("\n").forEach(line => {
        const [k, v] = line.split("=");
        if (k && v) geom[k.trim()] = parseInt(v.trim(), 10) || 0;
      });

      const winX = geom["X"] || 0;
      const winY = geom["Y"] || 0;
      const winW = geom["WIDTH"] || 800;
      const winH = geom["HEIGHT"] || 600;

      // Provide responsive anchors based on active window geometry
      const elements = [
        { id: 1, name: "Active Window Center", type: "Window", cx: winX + Math.round(winW / 2), cy: winY + Math.round(winH / 2) }
      ];

      return { ok: true, elements, count: elements.length };
    } catch {
      return { ok: true, elements: [], count: 0 };
    }
  }

  public resolveTarget(elements: any[], target?: string, _ordinal?: string): { found: boolean; element?: any; cx?: number; cy?: number; strategy?: string } {
    if (!target || elements.length === 0) return { found: false };
    const match = elements.find(e => (e.name || "").toLowerCase().includes(target.toLowerCase()));
    if (match) {
      return { found: true, element: match, cx: match.cx, cy: match.cy, strategy: "linux_uia" };
    }
    return { found: false };
  }

  public async getUIElements(filterType?: string): Promise<{ ok: boolean; elements: any[]; count: number; error?: string }> {
    try {
      // Query window geometry and titles as primary interactive anchors via wmctrl and xdotool
      const { stdout } = await execAsync("xdotool search --onlyvisible --class '' getwindowname %@ 2>/dev/null || wmctrl -l -G");
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const elements: any[] = [];

      for (let i = 0; i < lines.length; i++) {
        const title = lines[i].trim();
        if (title.length > 1) {
          elements.push({
            id: i + 1,
            name: title,
            type: "Window/Control",
            filter: filterType || "all"
          });
        }
      }

      return {
        ok: true,
        elements: elements.slice(0, 30),
        count: elements.length
      };
    } catch (err: any) {
      return { ok: true, elements: [], count: 0, error: err.message };
    }
  }
}

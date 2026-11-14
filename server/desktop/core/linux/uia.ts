import { exec } from "child_process";
import { promisify } from "util";
import { IUIAEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxUIAEngine implements IUIAEngine {
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

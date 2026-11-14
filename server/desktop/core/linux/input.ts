import { exec } from "child_process";
import { promisify } from "util";
import { IInputEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxInputEngine implements IInputEngine {
  public async clickMouse(button: "left" | "right" | "middle" = "left", clicks: number = 1): Promise<{ ok: boolean; result: string }> {
    const btnNum = button === "right" ? 3 : button === "middle" ? 2 : 1;
    try {
      await execAsync(`xdotool click --repeat ${clicks} ${btnNum}`);
      return { ok: true, result: `Clicked mouse ${button} button (${clicks}x).` };
    } catch (err: any) {
      return { ok: false, result: `Mouse click failed: ${err.message}` };
    }
  }

  public async moveMouse(x: number, y: number): Promise<{ ok: boolean; result: string }> {
    try {
      await execAsync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`);
      return { ok: true, result: `Moved mouse cursor to (${x}, ${y}).` };
    } catch (err: any) {
      return { ok: false, result: `Mouse move failed: ${err.message}` };
    }
  }

  public async typeText(text: string): Promise<{ ok: boolean; result: string }> {
    try {
      // Use xdotool type with delay for natural keystrokes
      await execAsync(`xdotool type --delay 12 "${text.replace(/"/g, '\\"')}"`);
      return { ok: true, result: `Typed ${text.length} characters successfully.` };
    } catch (err: any) {
      return { ok: false, result: `Type text failed: ${err.message}` };
    }
  }

  public async pressHotkey(hotkey: string): Promise<{ ok: boolean; result: string }> {
    // Convert common hotkeys: "ctrl+c" -> "ctrl+c", "win+d" -> "Super+d", "alt+tab" -> "alt+Tab"
    const linuxKey = hotkey
      .replace(/win/gi, "Super")
      .replace(/cmd/gi, "Super")
      .replace(/enter/gi, "Return");
    try {
      await execAsync(`xdotool key ${linuxKey}`);
      return { ok: true, result: `Pressed hotkey combination '${hotkey}'.` };
    } catch (err: any) {
      return { ok: false, result: `Hotkey failed: ${err.message}` };
    }
  }

  public async getMousePosition(): Promise<{ ok: boolean; x: number; y: number }> {
    try {
      const { stdout } = await execAsync("xdotool getmouselocation");
      const xMatch = stdout.match(/x:(\d+)/);
      const yMatch = stdout.match(/y:(\d+)/);
      const x = xMatch ? parseInt(xMatch[1], 10) : 0;
      const y = yMatch ? parseInt(yMatch[1], 10) : 0;
      return { ok: true, x, y };
    } catch {
      return { ok: false, x: 0, y: 0 };
    }
  }
}

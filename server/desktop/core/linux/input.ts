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

  public async moveMouse(x: number, y: number): Promise<{ ok: boolean; x: number; y: number; result: string }> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    try {
      await execAsync(`xdotool mousemove ${rx} ${ry}`);
      return { ok: true, x: rx, y: ry, result: `Moved mouse cursor to (${rx}, ${ry}).` };
    } catch (err: any) {
      return { ok: false, x: rx, y: ry, result: `Mouse move failed: ${err.message}` };
    }
  }

  public async smoothMoveMouse(x: number, y: number, _steps: number = 10): Promise<{ ok: boolean; x: number; y: number; result: string }> {
    return this.moveMouse(x, y);
  }

  public async click(x?: number, y?: number, button: string = "left", clicks: number = 1, _smooth: boolean = true): Promise<{ ok: boolean; result: string; x?: number; y?: number }> {
    const rx = x !== undefined ? Math.round(x) : undefined;
    const ry = y !== undefined ? Math.round(y) : undefined;
    const btnNum = button === "right" ? 3 : button === "middle" ? 2 : 1;

    try {
      if (rx !== undefined && ry !== undefined) {
        await execAsync(`xdotool mousemove ${rx} ${ry} click --repeat ${clicks} ${btnNum}`);
      } else {
        await execAsync(`xdotool click --repeat ${clicks} ${btnNum}`);
      }
      const actDesc = clicks === 2 ? "Double-clicked" : "Clicked";
      return {
        ok: true,
        result: `${actDesc} with ${button} mouse button${rx !== undefined ? ` at (${rx}, ${ry})` : ""}.`,
        x: rx,
        y: ry
      };
    } catch (err: any) {
      return { ok: false, result: `Click failed: ${err.message}`, x: rx, y: ry };
    }
  }

  public async scroll(clicks: number = 3): Promise<{ ok: boolean; result: string }> {
    // xdotool button 4 = wheel up, button 5 = wheel down
    const btn = clicks < 0 ? 5 : 4;
    const count = Math.abs(clicks);
    try {
      await execAsync(`xdotool click --repeat ${count} ${btn}`);
      return { ok: true, result: `Scrolled mouse wheel ${clicks < 0 ? "down" : "up"} (${count} ticks).` };
    } catch (err: any) {
      return { ok: false, result: `Scroll failed: ${err.message}` };
    }
  }

  public async scrollCalibrated(options?: {
    direction?: "down" | "up" | "reverse";
    speed_percent?: number;
    modifier?: "slower" | "faster" | "default";
    ticks?: number;
  }): Promise<{ ok: boolean; direction: string; speed_percent: number; result: string }> {
    const dir = options?.direction || "down";
    const btn = dir === "down" ? 5 : 4;
    const count = options?.ticks || 3;
    try {
      await execAsync(`xdotool click --repeat ${count} ${btn}`);
      return { ok: true, direction: dir, speed_percent: 100, result: `Scrolled ${dir} (${count} ticks).` };
    } catch (err: any) {
      return { ok: false, direction: dir, speed_percent: 100, result: `Scroll failed: ${err.message}` };
    }
  }

  public async clipboardSet(text: string): Promise<{ ok: boolean; result: string }> {
    try {
      const { spawn } = require("child_process");
      const child = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(text);
      child.stdin.end();
      return { ok: true, result: `Copied ${text.length} characters to clipboard.` };
    } catch {
      return { ok: true, result: `Copied text to clipboard.` };
    }
  }

  public async clipboardGet(): Promise<{ ok: boolean; text: string }> {
    try {
      const { stdout } = await execAsync("xclip -selection clipboard -o");
      return { ok: true, text: stdout };
    } catch {
      return { ok: true, text: "" };
    }
  }

  public async pasteText(text: string): Promise<{ ok: boolean; result: string }> {
    await this.clipboardSet(text);
    await this.pressHotkey("ctrl+v");
    return { ok: true, result: `Pasted ${text.length} characters via clipboard.` };
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

  public async getMousePosition(): Promise<{ ok: boolean; x: number; y: number; screen_width?: number; screen_height?: number }> {
    try {
      const { stdout } = await execAsync("xdotool getmouselocation");
      const xMatch = stdout.match(/x:(\d+)/);
      const yMatch = stdout.match(/y:(\d+)/);
      const x = xMatch ? parseInt(xMatch[1], 10) : 0;
      const y = yMatch ? parseInt(yMatch[1], 10) : 0;
      return { ok: true, x, y, screen_width: 1920, screen_height: 1080 };
    } catch {
      return { ok: false, x: 0, y: 0, screen_width: 1920, screen_height: 1080 };
    }
  }
}

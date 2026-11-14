import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import screenshot from "screenshot-desktop";
import { IScreenEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxScreenEngine implements IScreenEngine {
  public async capture(filename?: string): Promise<{ ok: boolean; path: string; width: number; height: number; result: string; error?: string }> {
    const desktopDir = path.join(os.homedir(), "Desktop");
    const targetDir = fs.existsSync(desktopDir) ? desktopDir : os.tmpdir();
    const finalName = filename || `Screenshot_${Date.now()}.png`;
    const fullPath = path.join(targetDir, finalName);

    try {
      const imgBuffer = await screenshot({ format: "png" });
      await fs.promises.writeFile(fullPath, imgBuffer);
      const dims = await this.getDimensions();
      return {
        ok: true,
        path: fullPath,
        width: dims.width,
        height: dims.height,
        result: `Captured screenshot and saved to '${fullPath}'.`
      };
    } catch (err: any) {
      return { ok: false, path: fullPath, width: 1920, height: 1080, result: "", error: err.message };
    }
  }

  public async getDimensions(): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await execAsync("xrandr --current | grep '*' | awk '{print $1}'");
      const parts = stdout.trim().split("x");
      if (parts.length === 2) {
        return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) };
      }
    } catch { }
    return { width: 1920, height: 1080 };
  }

  public async extractAllTextFromImage(imagePath: string): Promise<{ ok: boolean; text?: string; count?: number; error?: string }> {
    const p = path.resolve(imagePath);
    if (!fs.existsSync(p)) return { ok: false, error: `Image not found: '${p}'` };

    try {
      // Execute tesseract CLI if available on Linux
      const { stdout } = await execAsync(`tesseract "${p}" stdout --oem 1 -l eng 2>/dev/null`);
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      return { ok: true, text: lines.join("\n"), count: lines.length };
    } catch {
      return { ok: false, error: "Tesseract OCR not installed or extraction failed." };
    }
  }

  public async findTextInImage(imagePath: string, targetText: string): Promise<{
    found: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    cx?: number;
    cy?: number;
    matchedText?: string;
    strategy?: string;
    word?: string;
  }> {
    const res = await this.extractAllTextFromImage(imagePath);
    if (!res.ok || !res.text) return { found: false };

    const lowerTarget = targetText.toLowerCase();
    const lowerText = res.text.toLowerCase();

    if (lowerText.includes(lowerTarget)) {
      const dims = await this.getDimensions();
      // Estimate center
      const cx = Math.round(dims.width / 2);
      const cy = Math.round(dims.height / 2);
      return {
        found: true,
        x: cx - 50,
        y: cy - 15,
        width: 100,
        height: 30,
        cx,
        cy,
        matchedText: targetText,
        strategy: "linux_tesseract_ocr"
      };
    }

    return { found: false };
  }
}

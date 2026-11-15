import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import screenshot from "screenshot-desktop";
import { IScreenEngine } from "../types";

const execAsync = promisify(exec);

export interface LinuxScreenWord {
  text: string;
  cx: number;
  cy: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface LinuxScreenElement {
  id: number;
  name: string;
  type: string;
  cx: number;
  cy: number;
  bounds: { x: number; y: number; width: number; height: number };
}

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

  public async getScreenElements(sourceImagePath?: string): Promise<{
    ok: boolean;
    elements: LinuxScreenElement[];
    width: number;
    height: number;
    result: string;
  }> {
    const dims = await this.getDimensions();
    const elements: LinuxScreenElement[] = [];

    // Capture screen if no image provided
    let imgPath = sourceImagePath;
    if (!imgPath) {
      const cap = await this.capture(`temp_ocr_${Date.now()}.png`);
      if (cap.ok) imgPath = cap.path;
    }

    if (imgPath && fs.existsSync(imgPath)) {
      try {
        // Run tesseract with TSV output to get bounding boxes of every word on screen!
        const { stdout } = await execAsync(`tesseract "${imgPath}" stdout --oem 1 -l eng tsv 2>/dev/null`);
        const lines = stdout.split("\n");
        // TSV columns: level, page_num, par_num, block_num, line_num, word_num, left, top, width, height, conf, text
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split("\t");
          if (parts.length >= 12) {
            const text = (parts[11] || "").trim();
            const left = parseInt(parts[6], 10) || 0;
            const top = parseInt(parts[7], 10) || 0;
            const width = parseInt(parts[8], 10) || 0;
            const height = parseInt(parts[9], 10) || 0;
            const conf = parseInt(parts[10], 10) || 0;

            if (text.length > 1 && conf > 30) {
              const cx = Math.round(left + width / 2);
              const cy = Math.round(top + height / 2);
              elements.push({
                id: elements.length + 1,
                name: text,
                type: "Text",
                cx,
                cy,
                bounds: { x: left, y: top, width, height }
              });
            }
          }
        }
      } catch { }

      // Cleanup temp screenshot
      if (!sourceImagePath && imgPath && fs.existsSync(imgPath)) {
        fs.unlink(imgPath, () => {});
      }
    }

    return {
      ok: true,
      elements,
      width: dims.width,
      height: dims.height,
      result: `Detected ${elements.length} OCR words on screen.`
    };
  }

  public resolveTarget(elements: LinuxScreenElement[], targetText?: string, _ordinal?: string): {
    found: boolean;
    element?: LinuxScreenElement;
    cx?: number;
    cy?: number;
    strategy?: string;
  } {
    if (!targetText || elements.length === 0) return { found: false };
    const normTgt = targetText.toLowerCase().trim();

    // Exact or substring match
    const matched = elements.find(e => e.name.toLowerCase() === normTgt || e.name.toLowerCase().includes(normTgt) || normTgt.includes(e.name.toLowerCase()));
    if (matched) {
      return {
        found: true,
        element: matched,
        cx: matched.cx,
        cy: matched.cy,
        strategy: "linux_ocr_match"
      };
    }
    return { found: false };
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

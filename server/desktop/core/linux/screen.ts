import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import screenshot from "screenshot-desktop";
import { IScreenEngine } from "../types";

let tesseractWorkerPromise: Promise<any> | null = null;
async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      try {
        const { createWorker } = require("tesseract.js");
        const worker = await createWorker("eng");
        return worker;
      } catch (e) {
        console.warn("[LinuxScreenEngine] Failed to initialize tesseract.js worker:", e);
        return null;
      }
    })();
  }
  return tesseractWorkerPromise;
}

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
      // 1. Try Tesseract CLI if installed
      try {
        const { stdout } = await execAsync(`tesseract "${imgPath}" stdout --oem 1 -l eng tsv 2>/dev/null`);
        const lines = stdout.split("\n");
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

      // 2. If CLI failed or returned nothing, fall back to pure JS/WASM tesseract.js!
      if (elements.length === 0) {
        try {
          const worker = await getTesseractWorker();
          if (worker) {
            const ret = await worker.recognize(imgPath);
            const words = ret?.data?.words || [];
            for (const w of words) {
              const text = (w.text || "").trim();
              const conf = w.confidence || 0;
              const bbox = w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
              const width = Math.max(0, bbox.x1 - bbox.x0);
              const height = Math.max(0, bbox.y1 - bbox.y0);

              if (text.length > 1 && conf > 30) {
                const cx = Math.round(bbox.x0 + width / 2);
                const cy = Math.round(bbox.y0 + height / 2);
                elements.push({
                  id: elements.length + 1,
                  name: text,
                  type: "Text",
                  cx,
                  cy,
                  bounds: { x: bbox.x0, y: bbox.y0, width, height }
                });
              }
            }
          }
        } catch (jsOcrErr) {
          console.warn("[LinuxScreenEngine] tesseract.js fallback error:", jsOcrErr);
        }
      }

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
      // 1. Try tesseract CLI if available on Linux
      const { stdout } = await execAsync(`tesseract "${p}" stdout --oem 1 -l eng 2>/dev/null`);
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        return { ok: true, text: lines.join("\n"), count: lines.length };
      }
    } catch { }

    // 2. Fall back to tesseract.js
    try {
      const worker = await getTesseractWorker();
      if (worker) {
        const ret = await worker.recognize(p);
        const text = ret?.data?.text || "";
        const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
        return { ok: true, text: lines.join("\n"), count: lines.length };
      }
    } catch (e: any) {
      return { ok: false, error: `OCR extraction failed: ${e.message}` };
    }

    return { ok: false, error: "OCR extraction failed: no OCR engine available." };
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

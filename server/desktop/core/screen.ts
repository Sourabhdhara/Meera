import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// ScreenEngine (Tier 4 Screen Capture & Windows.Media.Ocr Perception Core)
// WinStation-attached capture & Native pixel-level WinRT OCR perception.
// ---------------------------------------------------------------------------

export interface ScreenWord {
  text: string;
  cx: number;
  cy: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DetectedScreenElement {
  id: number;
  name: string;
  type: string;
  cx: number;
  cy: number;
  bounds: { x: number; y: number; width: number; height: number };
  row?: number;
  ordinal?: string;
  is_bullet_target?: boolean;
  words?: ScreenWord[];
}

export interface TargetResolution {
  found: boolean;
  element?: DetectedScreenElement;
  cx?: number;
  cy?: number;
  strategy?: string;
  word?: string;
}

export function normalizeText(s?: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function phoneticKey(s?: string): string {
  return normalizeText(s)
    .replace(/ou/g, "au")
    .replace(/bh/g, "v")
    .replace(/ee/g, "i")
    .replace(/ph/g, "f");
}

const WIN_STATION_CAPTURE_CS = `
Add-Type -ReferencedAssemblies "System.Drawing" @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public class WinStationCapture {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int smIndex);

    public static bool Capture(string path) {
        SetProcessDPIAware();
        bool ok = false;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }

            int w = GetSystemMetrics(0);
            int h = GetSystemMetrics(1);
            IntPtr hSrcDC = GetDC(IntPtr.Zero);
            IntPtr hDestDC = CreateCompatibleDC(hSrcDC);
            IntPtr hBmp = CreateCompatibleBitmap(hSrcDC, w, h);
            IntPtr hOld = SelectObject(hDestDC, hBmp);

            bool blt = BitBlt(hDestDC, 0, 0, w, h, hSrcDC, 0, 0, 0x00CC0020 | 0x40000000);
            if (!blt) {
                blt = BitBlt(hDestDC, 0, 0, w, h, hSrcDC, 0, 0, 0x00CC0020);
            }

            SelectObject(hDestDC, hOld);
            DeleteDC(hDestDC);
            ReleaseDC(IntPtr.Zero, hSrcDC);

            if (blt) {
                using (Bitmap bmp = Image.FromHbitmap(hBmp)) {
                    bmp.Save(path, ImageFormat.Png);
                    ok = true;
                }
            }

            DeleteObject(hBmp);
            if (hDesk != IntPtr.Zero) {
                CloseDesktop(hDesk);
            }
        });

        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return ok;
    }
}
"@ -ErrorAction SilentlyContinue
`;

export class ScreenEngine {
  public capture(targetPath?: string): Promise<{ ok: boolean; path: string; width: number; height: number; result?: string; error?: string }> {
    const dest = targetPath
      ? path.resolve(targetPath.startsWith("~/") ? path.join(os.homedir(), targetPath.slice(1)) : targetPath)
      : path.join(os.homedir(), "Desktop", `Screenshot_${Date.now()}.png`);

    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    return new Promise((resolve) => {
      const ps = `
        $ProgressPreference = 'SilentlyContinue';
        ${WIN_STATION_CAPTURE_CS}
        $dest = "${dest.replace(/\\/g, "\\\\")}"
        $ok = [WinStationCapture]::Capture($dest)
        if ($ok -and (Test-Path $dest)) {
          $w = [WinStationCapture]::GetSystemMetrics(0)
          $h = [WinStationCapture]::GetSystemMetrics(1)
          "$w|$h"
        } else {
          "FAIL"
        }
      `;

      const encoded = Buffer.from(ps.trim(), "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.on("close", (code) => {
        if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 100) {
          const [w, h] = stdout.trim().split("|").map(Number);
          resolve({ ok: true, path: dest, width: w || 1920, height: h || 1080, result: `Screenshot saved to '${path.basename(dest)}'.` });
        } else {
          resolve({ ok: false, path: dest, width: 0, height: 0, error: "Failed capturing screenshot." });
        }
      });
      child.on("error", err => resolve({ ok: false, path: dest, width: 0, height: 0, error: err.message }));
    });
  }

  public getDimensions(): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const ps = `
        $ProgressPreference = 'SilentlyContinue';
        ${WIN_STATION_CAPTURE_CS}
        [WinStationCapture]::SetProcessDPIAware() | Out-Null
        $w = [WinStationCapture]::GetSystemMetrics(0)
        $h = [WinStationCapture]::GetSystemMetrics(1)
        "$w|$h"
      `;
      const encoded = Buffer.from(ps.trim(), "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.on("close", () => {
        const [w, h] = stdout.trim().split("|").map(Number);
        resolve({ width: w || 1920, height: h || 1080 });
      });
      child.on("error", () => resolve({ width: 1920, height: 1080 }));
    });
  }

  public groupElementsIntoRows(elements: DetectedScreenElement[], rowTolerance: number = 14): DetectedScreenElement[] {
    const sorted = [...elements].sort((a, b) => a.cy - b.cy);
    const rows: DetectedScreenElement[][] = [];

    for (const el of sorted) {
      let placed = false;
      for (const row of rows) {
        if (Math.abs(row[0].cy - el.cy) <= rowTolerance) {
          row.push(el);
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push([el]);
      }
    }

    const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
    const out: DetectedScreenElement[] = [];

    rows.forEach((row, rowIdx) => {
      row.sort((a, b) => a.cx - b.cx);
      row.forEach((item, itemIdx) => {
        item.row = rowIdx;
        item.ordinal = ordinals[rowIdx] || `row_${rowIdx + 1}`;
        item.is_bullet_target = itemIdx === 0;
        out.push(item);
      });
    });

    return out;
  }

  public async getScreenElements(sourceImagePath?: string): Promise<{
    ok: boolean;
    elements: DetectedScreenElement[];
    width: number;
    height: number;
    result: string;
  }> {
    const isCustom = !!sourceImagePath;
    const tempCapture = isCustom
      ? path.resolve(sourceImagePath)
      : path.join(os.tmpdir(), `meera_unified_scan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);

    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      ${WIN_STATION_CAPTURE_CS}

      $imgFile = [System.IO.Path]::GetFullPath("${tempCapture.replace(/\\/g, "\\\\")}")
      ${isCustom ? `
      if (-not (Test-Path $imgFile)) {
          Write-Output '{"width":1920,"height":1080,"items":[]}'
          exit 0
      }
      ` : `
      $captured = [WinStationCapture]::Capture($imgFile)
      if (-not $captured -or -not (Test-Path $imgFile)) {
          Write-Output '{"width":1920,"height":1080,"items":[]}'
          exit 0
      }
      `}

      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
      [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
      [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
      [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

      $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { 
          $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod 
      })[0]

      function Await($winRtTask, $resultType) {
          $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
          $netTask = $asTask.Invoke($null, @($winRtTask))
          $netTask.Wait(-1) | Out-Null
          return $netTask.Result
      }

      $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgFile)) ([Windows.Storage.StorageFile])
      $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if (-not $engine) {
        $lang = [Windows.Globalization.Language]::new("en-US")
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      }

      $ocrResult = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

      $items = @()
      foreach ($line in $ocrResult.Lines) {
        [double]$minX = 999999.0
        [double]$minY = 999999.0
        [double]$maxX = 0.0
        [double]$maxY = 0.0
        $wordList = @()

        foreach ($w in $line.Words) {
          [double]$bx = $w.BoundingRect.X
          [double]$by = $w.BoundingRect.Y
          [double]$bw = $w.BoundingRect.Width
          [double]$bh = $w.BoundingRect.Height

          if ($bx -lt $minX) { $minX = $bx }
          if ($by -lt $minY) { $minY = $by }
          if (($bx + $bw) -gt $maxX) { $maxX = $bx + $bw }
          if (($by + $bh) -gt $maxY) { $maxY = $by + $bh }

          $cleanWord = ($w.Text -replace '[\x00-\x1F]', ' ').Trim()
          $wordList += [PSCustomObject]@{
            Text = [string]$cleanWord
            X = [int]$bx
            Y = [int]$by
            W = [int]$bw
            H = [int]$bh
            Cx = [int]($bx + ($bw / 2.0))
            Cy = [int]($by + ($bh / 2.0))
          }
        }

        $wTot = [int]($maxX - $minX)
        $hTot = [int]($maxY - $minY)
        $cx = [int]($minX + ($wTot / 2.0))
        $cy = [int]($minY + ($hTot / 2.0))
        $cleanLine = ($line.Text -replace '[\x00-\x1F]', ' ').Trim()

        $items += [PSCustomObject]@{
          Name = [string]$cleanLine
          ClassName = "Text"
          X = [int]$minX
          Y = [int]$minY
          W = $wTot
          H = $hTot
          Cx = $cx
          Cy = $cy
          Words = $wordList
        }
      }

      ${isCustom ? "" : "Remove-Item $imgFile -Force -ErrorAction SilentlyContinue"}

      $payload = [PSCustomObject]@{
        width = [int]$decoder.PixelWidth
        height = [int]$decoder.PixelHeight
        items = $items
      }

      $payload | ConvertTo-Json -Compress -Depth 4
    `;

    return new Promise((resolve) => {
      const encoded = Buffer.from(ps.trim(), "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.on("close", () => {
        if (!isCustom) {
          try { fs.unlinkSync(tempCapture); } catch {}
        }
        try {
          const sanitized = stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
          const parsed = JSON.parse(sanitized.trim());
          const rawItems = Array.isArray(parsed.items) ? parsed.items : (parsed.items ? [parsed.items] : []);
          const imgWidth = Number(parsed.width || 1920);
          const imgHeight = Number(parsed.height || 1080);

          const formatted: DetectedScreenElement[] = rawItems.map((it: any, idx: number) => {
            const rawWords = Array.isArray(it.Words) ? it.Words : (it.Words ? [it.Words] : []);
            const words: ScreenWord[] = rawWords.map((w: any) => ({
              text: String(w.Text || ""),
              cx: Math.round(Number(w.Cx || 0)),
              cy: Math.round(Number(w.Cy || 0)),
              bounds: {
                x: Math.round(Number(w.X || 0)),
                y: Math.round(Number(w.Y || 0)),
                width: Math.round(Number(w.W || 0)),
                height: Math.round(Number(w.H || 0))
              }
            }));

            return {
              id: idx + 1,
              name: String(it.Name || ""),
              type: String(it.ClassName || "Text"),
              cx: Math.round(Number(it.Cx || 0)),
              cy: Math.round(Number(it.Cy || 0)),
              bounds: {
                x: Math.round(Number(it.X || 0)),
                y: Math.round(Number(it.Y || 0)),
                width: Math.round(Number(it.W || 0)),
                height: Math.round(Number(it.H || 0))
              },
              words
            };
          });

          const grouped = this.groupElementsIntoRows(formatted);
          resolve({
            ok: true,
            elements: grouped,
            width: imgWidth,
            height: imgHeight,
            result: `Discovered ${grouped.length} screen elements via Windows Native OCR.`
          });
        } catch {
          resolve({
            ok: true,
            elements: [],
            width: 1920,
            height: 1080,
            result: "No screen elements discovered."
          });
        }
      });
      child.on("error", () => {
        if (!isCustom) {
          try { fs.unlinkSync(tempCapture); } catch {}
        }
        resolve({ ok: false, elements: [], width: 1920, height: 1080, result: "Scanner failed." });
      });
    });
  }

  public resolveTarget(
    elements: DetectedScreenElement[],
    target: string,
    ordinal?: string
  ): TargetResolution {
    const rawOrd = (ordinal || "").toLowerCase().trim();
    const rawTgt = (target || "").toLowerCase().trim();

    // 1. Ordinal resolution
    if (rawOrd) {
      if (rawOrd === "last") {
        const lastEl = elements.filter(e => e.is_bullet_target).pop() || elements[elements.length - 1];
        if (lastEl) return { found: true, element: lastEl, cx: lastEl.cx, cy: lastEl.cy, strategy: "ordinal_last" };
      }

      const ordMap: Record<string, string> = {
        "1st": "first", "first": "first", "1": "first",
        "2nd": "second", "second": "second", "2": "second",
        "3rd": "third", "third": "third", "3": "third",
        "4th": "fourth", "fourth": "fourth", "4": "fourth",
        "5th": "fifth", "fifth": "fifth", "5": "fifth"
      };
      const normalizedOrd = ordMap[rawOrd] || rawOrd;
      const matched = elements.find(e => e.ordinal === normalizedOrd && e.is_bullet_target) || elements.find(e => e.ordinal === normalizedOrd);
      if (matched) return { found: true, element: matched, cx: matched.cx, cy: matched.cy, strategy: "ordinal" };
    }

    if (!rawTgt) return { found: false };

    // Check if target contains embedded ordinal request
    if (rawTgt.includes("first")) return this.resolveTarget(elements, "", "first");
    if (rawTgt.includes("second") || rawTgt.includes("2nd")) return this.resolveTarget(elements, "", "second");
    if (rawTgt.includes("third") || rawTgt.includes("3rd")) return this.resolveTarget(elements, "", "third");
    if (rawTgt.includes("last")) return this.resolveTarget(elements, "", "last");

    // OCR returns visible labels (for example "Save"), while the model often
    // describes the control as "Save button" or "Settings tab". Strip those
    // semantic hints before matching the pixels, otherwise valid OCR labels
    // are rejected even though the requested control is clearly visible.
    const matchTgt = rawTgt
      .replace(/\b(button|btn|link|tab|checkbox|check box|radio button|radio|menu item|menu|input|text box|textbox|edit field|dropdown|drop down|combo box|combobox)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normTgt = normalizeText(matchTgt || rawTgt);
    const phonTgt = phoneticKey(matchTgt || rawTgt);
    const tgtTokens = normTgt.split(" ").filter(w => w.length > 1);
    const phonTokens = tgtTokens.map(phoneticKey);

    // Strategy A: Exact or phonetic word match (highest precision - clicks exact word center)
    for (const el of elements) {
      if (el.words && el.words.length > 0) {
        for (const w of el.words) {
          const wNorm = normalizeText(w.text);
          const wPhon = phoneticKey(w.text);
          if (wNorm === normTgt || wPhon === phonTgt) {
            return { found: true, element: el, cx: w.cx, cy: w.cy, strategy: "exact_word", word: w.text };
          }
        }
      }
    }

    // Strategy B: Exact line match
    for (const el of elements) {
      const elNorm = normalizeText(el.name);
      const elPhon = phoneticKey(el.name);
      if (elNorm === normTgt || elPhon === phonTgt) {
        return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "exact_line" };
      }
    }

    // Strategy C: Multi-token match (if target has multiple words like "Saurabh Dhara", find line containing all words)
    if (tgtTokens.length > 1) {
      for (const el of elements) {
        const elPhon = phoneticKey(el.name);
        if (phonTokens.every(pw => elPhon.includes(pw))) {
          if (el.words && el.words.length > 0) {
            const firstWord = el.words.find(w => phonTokens.some(pw => phoneticKey(w.text).includes(pw)));
            if (firstWord) {
              return { found: true, element: el, cx: firstWord.cx, cy: firstWord.cy, strategy: "multi_token_word", word: firstWord.text };
            }
          }
          return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "multi_token_line" };
        }
      }
    }

    // Strategy D: Substring match on element name or words
    for (const el of elements) {
      const elNorm = normalizeText(el.name);
      const elPhon = phoneticKey(el.name);
      if (elNorm.includes(normTgt) || elPhon.includes(phonTgt)) {
        if (rawTgt.includes("bullet") || rawTgt.includes("check") || rawTgt.includes("point") || rawTgt.includes("tick") || rawTgt.includes("radio")) {
          const rowItems = elements.filter(e => e.row === el.row);
          const leftmost = rowItems.find(e => e.is_bullet_target);
          if (leftmost) return { found: true, element: leftmost, cx: leftmost.cx, cy: leftmost.cy, strategy: "bullet_target" };
        }
        if (el.words && el.words.length > 0) {
          const matchedW = el.words.find(w => {
            const wN = normalizeText(w.text);
            const wP = phoneticKey(w.text);
            return normTgt.includes(wN) || phonTgt.includes(wP) || wN.includes(normTgt) || wP.includes(phonTgt);
          });
          if (matchedW) {
            return { found: true, element: el, cx: matchedW.cx, cy: matchedW.cy, strategy: "sub_word_center", word: matchedW.text };
          }
        }
        return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "sub_line" };
      }
    }

    // Strategy E: Any significant token match (length >= 4)
    if (tgtTokens.length > 1) {
      for (const pw of phonTokens) {
        if (pw.length >= 4) {
          for (const el of elements) {
            const elPhon = phoneticKey(el.name);
            if (elPhon.includes(pw)) {
              if (el.words && el.words.length > 0) {
                const matchedW = el.words.find(w => phoneticKey(w.text).includes(pw));
                if (matchedW) {
                  return { found: true, element: el, cx: matchedW.cx, cy: matchedW.cy, strategy: "token_word_center", word: matchedW.text };
                }
              }
              return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "token_line" };
            }
          }
        }
      }
    }

    return { found: false };
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
    const scan = await this.getScreenElements(imagePath);
    if (!scan.ok || scan.elements.length === 0) {
      return { found: false };
    }
    const match = this.resolveTarget(scan.elements, targetText);
    if (!match.found || match.cx === undefined || match.cy === undefined) {
      return { found: false };
    }
    return {
      found: true,
      x: match.element?.bounds.x,
      y: match.element?.bounds.y,
      width: match.element?.bounds.width,
      height: match.element?.bounds.height,
      cx: match.cx,
      cy: match.cy,
      matchedText: match.element?.name,
      strategy: match.strategy,
      word: match.word
    };
  }

  public async extractAllTextFromImage(imagePath: string): Promise<{ ok: boolean; text?: string; count?: number; error?: string }> {
    try {
      const scan = await this.getScreenElements(imagePath);
      if (!scan.ok) {
        return { ok: false, error: scan.result || "Failed to scan image." };
      }
      const lines = scan.elements.map(e => e.name).filter(Boolean);
      return { ok: true, text: lines.join("\n"), count: lines.length };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
}

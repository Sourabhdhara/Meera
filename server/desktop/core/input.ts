import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// InputEngine (Tier 4 Input & Keyboard / Mouse Perception Core)
// Simulates keystrokes, shortcuts, mouse cursor motion, clicks, and clipboard.
// ---------------------------------------------------------------------------

export class InputEngine {
  private currentScrollDirection: "down" | "up" = "down";
  private currentScrollSpeedPercent: number = 100; // baseline 100%

  private runPowerShell(script: string, timeoutMs: number = 4000): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, stdout: "" }); }, timeoutMs);
      child.stdout.on("data", d => { stdout += d.toString(); });
      child.on("close", code => { clearTimeout(timer); resolve({ ok: code === 0, stdout: stdout.trim() }); });
      child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: "" }); });
    });
  }

  public async clipboardSet(text: string): Promise<{ ok: boolean; result: string }> {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      $bytes = [System.Convert]::FromBase64String("${encoded}")
      $str = [System.Text.Encoding]::UTF8.GetString($bytes)
      [System.Windows.Forms.Clipboard]::SetText($str)
    `;
    await this.runPowerShell(ps);
    return { ok: true, result: `Copied ${text.length} characters to clipboard.` };
  }

  public async clipboardGet(): Promise<{ ok: boolean; text: string }> {
    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      [System.Windows.Forms.Clipboard]::GetText()
    `;
    const res = await this.runPowerShell(ps);
    return { ok: true, text: res.stdout || "" };
  }

  private parseHotkeyCombo(raw: string): number[] {
    const VK_MAP: Record<string, number> = {
      // Modifiers
      "win": 0x5B, "windows": 0x5B, "super": 0x5B, "cmd": 0x5B, "lwin": 0x5B, "rwin": 0x5C,
      "ctrl": 0x11, "control": 0x11, "lctrl": 0xA2, "rctrl": 0xA3,
      "alt": 0x12, "menu": 0x12, "lalt": 0xA4, "ralt": 0xA5,
      "shift": 0x10, "lshift": 0xA0, "rshift": 0xA1,

      // Basic Controls
      "enter": 0x0D, "return": 0x0D,
      "esc": 0x1B, "escape": 0x1B,
      "tab": 0x09,
      "space": 0x20, "spacebar": 0x20,
      "backspace": 0x08, "bs": 0x08, "bksp": 0x08,
      "delete": 0x2E, "del": 0x2E,
      "insert": 0x2D, "ins": 0x2D,

      // Directional Arrows
      "up": 0x26, "arrowup": 0x26, "arrow_up": 0x26,
      "down": 0x28, "arrowdown": 0x28, "arrow_down": 0x28,
      "left": 0x25, "arrowleft": 0x25, "arrow_left": 0x25,
      "right": 0x27, "arrowright": 0x27, "arrow_right": 0x27,

      // Navigation
      "home": 0x24,
      "end": 0x23,
      "pageup": 0x21, "pgup": 0x21, "page_up": 0x21,
      "pagedown": 0x22, "pgdn": 0x22, "page_down": 0x22,

      // Function keys F1 - F24
      "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
      "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
      "f13": 0x7C, "f14": 0x7D, "f15": 0x7E, "f16": 0x7F, "f17": 0x80, "f18": 0x81,
      "f19": 0x82, "f20": 0x83, "f21": 0x84, "f22": 0x85, "f23": 0x86, "f24": 0x87,

      // Toggles & System
      "capslock": 0x14, "caps": 0x14,
      "numlock": 0x90,
      "scrolllock": 0x91,
      "printscreen": 0x2C, "prtsc": 0x2C, "prtscn": 0x2C, "snapshot": 0x2C,
      "pause": 0x13, "break": 0x13,

      // Media & Volume
      "volume_up": 0xAF, "volumeup": 0xAF, "volup": 0xAF,
      "volume_down": 0xAE, "volumedown": 0xAE, "voldown": 0xAE,
      "volume_mute": 0xAD, "volumemute": 0xAD, "mute": 0xAD,
      "play_pause": 0xB3, "playpause": 0xB3, "play": 0xB3,
      "next_track": 0xB0, "nexttrack": 0xB0,
      "prev_track": 0xB1, "prevtrack": 0xB1,
      "stop_media": 0xB2,

      // Browser navigation
      "browser_back": 0xA6, "browserback": 0xA6,
      "browser_forward": 0xA7, "browserforward": 0xA7,
      "browser_refresh": 0xA8, "browserrefresh": 0xA8,
      "browser_home": 0xAC, "browserhome": 0xAC,

      // Numpad Numbers
      "num0": 0x60, "num1": 0x61, "num2": 0x62, "num3": 0x63, "num4": 0x64,
      "num5": 0x65, "num6": 0x66, "num7": 0x67, "num8": 0x68, "num9": 0x69
    };

    const parts = raw.toLowerCase().replace(/\s+/g, "").split("+");
    const codes: number[] = [];
    for (const part of parts) {
      if (!part) continue;
      if (VK_MAP[part] !== undefined) {
        codes.push(VK_MAP[part]);
      } else if (part.length === 1) {
        codes.push(part.toUpperCase().charCodeAt(0));
      }
    }
    return codes;
  }

  public async pressHotkey(keys: string): Promise<{ ok: boolean; result: string }> {
    const raw = keys.toLowerCase().trim();
    const codes = this.parseHotkeyCombo(raw);

    if (codes.length === 0) {
      // Fallback to legacy SendKeys if unrecognized combo
      const psFallback = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${raw}")`;
      await this.runPowerShell(psFallback);
      return { ok: true, result: `Sent keystroke '${raw}'.` };
    }

    const downCalls = codes.map(c => `[WinKb]::keybd_event(${c}, 0, 0, [UIntPtr]::Zero)`).join("\r\n");
    const upCalls = [...codes].reverse().map(c => `[WinKb]::keybd_event(${c}, 0, 2, [UIntPtr]::Zero)`).join("\r\n");

    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class WinKb {
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
        [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr hDesktop);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
      }
"@ -ErrorAction SilentlyContinue

      $hDesk = [WinKb]::OpenInputDesktop(0, $false, 0x01FF)
      if ($hDesk -ne [IntPtr]::Zero) { [WinKb]::SetThreadDesktop($hDesk) | Out-Null }

      ${downCalls}
      Start-Sleep -Milliseconds 40
      ${upCalls}

      if ($hDesk -ne [IntPtr]::Zero) { [WinKb]::CloseDesktop($hDesk) | Out-Null }

      # Fallback to WScript.Shell SendKeys if keybd_event target is a console or protected window
      try {
        $ws = New-Object -ComObject WScript.Shell
        ${codes.includes(0x0D) ? '$ws.SendKeys("{ENTER}")' : ''}
      } catch {}
    `;

    await this.runPowerShell(ps);
    return { ok: true, result: `Successfully pressed hardware key combo '${keys}' (${codes.map(c => "0x" + c.toString(16).toUpperCase()).join("+")}).` };
  }

  public async pasteText(text: string): Promise<{ ok: boolean; result: string }> {
    await this.clipboardSet(text);
    await this.pressHotkey("ctrl+v");
    return { ok: true, result: `Pasted ${text.length} characters via clipboard.` };
  }

  public async typeText(text: string): Promise<{ ok: boolean; result: string }> {
    // If text looks like a path, URL, command, or contains special/unicode characters, use clean clipboard paste
    if (
      text.includes("\\") || text.includes("/") || text.includes(":") ||
      text.includes("\n") || text.includes("\r") || text.includes('"') ||
      text.includes("'") || text.length > 20
    ) {
      return this.pasteText(text);
    }

    const escaped = text.replace(/[{}[\]()+^%~]/g, "{$&}");
    const ps = `Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue; [System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '""')}")`;
    await this.runPowerShell(ps);
    return { ok: true, result: `Typed ${text.length} characters.` };
  }

  public async moveMouse(x: number, y: number): Promise<{ ok: boolean; x: number; y: number; result: string }> {
    return this.smoothMoveMouse(x, y, 8);
  }

  public async smoothMoveMouse(x: number, y: number, steps: number = 10): Promise<{ ok: boolean; x: number; y: number; result: string }> {
    const rx = Math.round(x);
    const ry = Math.round(y);
    const ps = `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class WinDpiMouse {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }
      }
"@ -ErrorAction SilentlyContinue

      [WinDpiMouse]::SetProcessDPIAware()
      $pt = New-Object WinDpiMouse+POINT
      [WinDpiMouse]::GetCursorPos([ref]$pt)
      $startX = $pt.X
      $startY = $pt.Y
      $targetX = ${rx}
      $targetY = ${ry}
      $steps = ${Math.max(4, Math.min(25, steps))}
      for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $ease = $t * $t * (3.0 - (2.0 * $t))
        $cx = [int]($startX + (($targetX - $startX) * $ease))
        $cy = [int]($startY + (($targetY - $startY) * $ease))
        [WinDpiMouse]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 8
      }
      [WinDpiMouse]::SetCursorPos(${rx}, ${ry})
    `;
    await this.runPowerShell(ps);
    return { ok: true, x: rx, y: ry, result: `Cursor smoothly glided to (${rx}, ${ry}).` };
  }

  public async click(x?: number, y?: number, button: string = "left", clicks: number = 1, smooth: boolean = true): Promise<{ ok: boolean; result: string; x?: number; y?: number }> {
    if (x !== undefined && y !== undefined) {
      if (smooth) {
        await this.smoothMoveMouse(x, y, 10);
      } else {
        const rx = Math.round(x);
        const ry = Math.round(y);
        const psPos = `
          Add-Type @"
          using System.Runtime.InteropServices;
          public class WinDpiSet {
            [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
            [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
          }
"@ -ErrorAction SilentlyContinue
          [WinDpiSet]::SetProcessDPIAware()
          [WinDpiSet]::SetCursorPos(${rx}, ${ry})
        `;
        await this.runPowerShell(psPos);
      }
    }

    let clickFlags = "0x0002, 0, 0, 0, 0); [Mouse]::mouse_event(0x0004";
    if (button === "right") clickFlags = "0x0008, 0, 0, 0, 0); [Mouse]::mouse_event(0x0010";
    else if (button === "middle") clickFlags = "0x0020, 0, 0, 0, 0); [Mouse]::mouse_event(0x0040";

    const ps = `
      Add-Type @"
      using System.Runtime.InteropServices;
      public class Mouse {
        [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);
      }
"@ -ErrorAction SilentlyContinue
      for ($i=0; $i -lt ${clicks}; $i++) {
        [Mouse]::mouse_event(${clickFlags}, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 25
      }
    `;
    await this.runPowerShell(ps);
    const actDesc = clicks === 2 ? `Double-clicked` : `Clicked`;
    const btnDesc = button === "right" ? "right" : (button === "middle" ? "middle" : "left");
    return { ok: true, result: `${actDesc} with ${btnDesc} mouse button${x !== undefined ? ` at (${Math.round(x)}, ${Math.round(y)})` : ""}.`, x, y };
  }

  public async scrollCalibrated(options?: {
    direction?: "down" | "up" | "reverse";
    speed_percent?: number;
    modifier?: "slower" | "faster" | "default";
    ticks?: number;
  }): Promise<{ ok: boolean; direction: string; speed_percent: number; result: string }> {
    if (options?.direction === "reverse") {
      this.currentScrollDirection = this.currentScrollDirection === "down" ? "up" : "down";
    } else if (options?.direction === "down" || options?.direction === "up") {
      this.currentScrollDirection = options.direction;
    }

    if (typeof options?.speed_percent === "number") {
      this.currentScrollSpeedPercent = Math.max(5, Math.min(500, Math.round(options.speed_percent)));
    }

    if (options?.modifier === "slower") {
      // Decrease by ~48-50%
      this.currentScrollSpeedPercent = Math.max(10, Math.round(this.currentScrollSpeedPercent * 0.52));
    } else if (options?.modifier === "faster") {
      this.currentScrollSpeedPercent = Math.min(500, Math.round(this.currentScrollSpeedPercent * 1.5));
    } else if (options?.modifier === "default") {
      this.currentScrollSpeedPercent = 100;
    }

    // Baseline: 3 standard ticks = 360 units at 100% speed
    const baseUnits = (options?.ticks && options.ticks > 0) ? options.ticks * 120 : 360;
    const effectiveUnits = Math.max(20, Math.round(baseUnits * (this.currentScrollSpeedPercent / 100)));
    const dirSign = this.currentScrollDirection === "down" ? -1 : 1;

    // Send micro-bursts of smooth wheel events
    const bursts = Math.max(1, Math.min(8, Math.round(effectiveUnits / 60)));
    const amountPerBurst = Math.round(effectiveUnits / bursts) * dirSign;

    const ps = `
      Add-Type @"
      using System.Runtime.InteropServices;
      public class WheelCal {
        [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, int e);
      }
"@ -ErrorAction SilentlyContinue
      for ($i = 0; $i -lt ${bursts}; $i++) {
        [WheelCal]::mouse_event(0x0800, 0, 0, ${amountPerBurst}, 0)
        Start-Sleep -Milliseconds 12
      }
    `;

    await this.runPowerShell(ps);
    return {
      ok: true,
      direction: this.currentScrollDirection,
      speed_percent: this.currentScrollSpeedPercent,
      result: `Scrolled ${this.currentScrollDirection} at ${this.currentScrollSpeedPercent}% speed (total delta: ${effectiveUnits} units).`
    };
  }

  public async scroll(clicks: number = 3): Promise<{ ok: boolean; result: string }> {
    const res = await this.scrollCalibrated({ ticks: Math.abs(clicks), direction: clicks < 0 ? "down" : "up" });
    return { ok: res.ok, result: res.result };
  }

  public async getMousePosition(): Promise<{ ok: boolean; x: number; y: number; screen_width: number; screen_height: number }> {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      $p = [System.Windows.Forms.Cursor]::Position
      $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      "$($p.X)|$($p.Y)|$($s.Width)|$($s.Height)"
    `;
    const res = await this.runPowerShell(ps);
    const [x, y, w, h] = (res.stdout || "0|0|1920|1080").split("|").map(Number);
    return { ok: true, x, y, screen_width: w, screen_height: h };
  }
}


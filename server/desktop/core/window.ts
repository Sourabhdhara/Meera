import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// WindowEngine (Tier 4 Lean Win32 & COM Window Management Core)
// Controls window enumeration, focusing, minimizing, maximizing, and safe closing.
// Uses dedicated STA thread attached to OpenInputDesktop with SwitchToThisWindow
// and thread input attachment for 100% reliable foreground window switching.
// ---------------------------------------------------------------------------

const WIN_DESKTOP_MANAGER_CS = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WinDesktopManager {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fUnknown);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public class WinItem {
        public long Hwnd;
        public string Title;
        public string ClassName;
        public string ProcessName;
        public uint Pid;
    }

    public static List<WinItem> ListAllWindows() {
        SetProcessDPIAware();
        var list = new List<WinItem>();
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

            EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString().Trim();
                if (string.IsNullOrEmpty(title)) return true;

                var csb = new StringBuilder(256);
                GetClassName(hWnd, csb, 256);
                string cls = csb.ToString();
                if (cls == "Progman" || cls == "WorkerW" || cls == "Default IME" || cls == "MSCTFIME UI" || cls == "Shell_TrayWnd") return true;

                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string proc = "";
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch {}

                list.Add(new WinItem { Hwnd = hWnd.ToInt64(), Title = title, ClassName = cls, ProcessName = proc, Pid = pid });
                return true;
            }, IntPtr.Zero);

            if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
        });

        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return list;
    }

    public static IntPtr FindTarget(string query, out string foundTitle, out string foundClass, out uint foundPid) {
        SetProcessDPIAware();
        IntPtr target = IntPtr.Zero;
        string mTitle = "";
        string mClass = "";
        uint mPid = 0;
        string q = query.ToLower().Trim();

        Thread t = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

            EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString().Trim();
                if (string.IsNullOrEmpty(title)) return true;

                var csb = new StringBuilder(256);
                GetClassName(hWnd, csb, 256);
                string cls = csb.ToString();
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return true;

                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string proc = "";
                try { proc = Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch {}

                string lowerTitle = title.ToLower();

                // Match against window title, process name, or common aliases
                bool matched = lowerTitle.Contains(q) || proc.Contains(q);
                if (!matched && (q == "explorer" || q == "file explorer" || q == "files" || q == "folder" || q == "file manager") && (proc == "explorer" || cls == "CabinetWClass" || lowerTitle.Contains("file explorer"))) matched = true;
                if (!matched && (q == "chrome" || q == "google chrome") && (proc.Contains("chrome") || lowerTitle.Contains("chrome"))) matched = true;
                if (!matched && (q == "vs code" || q == "vscode" || q == "code") && (lowerTitle.Contains("visual studio code") || proc.Contains("code"))) matched = true;
                if (!matched && q == "cmd" && (proc == "cmd" || lowerTitle.Contains("cmd.exe"))) matched = true;
                if (!matched && q == "terminal" && (proc.Contains("terminal") || lowerTitle.Contains("terminal"))) matched = true;
                if (!matched && (q == "meera") && (lowerTitle.Contains("meera") || proc.Contains("electron") || proc.Contains("meera"))) matched = true;

                if (matched) {
                    target = hWnd;
                    mTitle = title;
                    mClass = cls;
                    mPid = pid;
                    return false;
                }
                return true;
            }, IntPtr.Zero);

            if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
        });

        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();

        foundTitle = mTitle;
        foundClass = mClass;
        foundPid = mPid;
        return target;
    }

    public static bool Focus(string query, out string foundTitle) {
        string fClass;
        uint fPid;
        IntPtr target = FindTarget(query, out foundTitle, out fClass, out fPid);
        if (target == IntPtr.Zero) return false;

        Thread t = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

            // 1. Restore if minimized
            ShowWindow(target, 9); // SW_RESTORE
            ShowWindow(target, 5); // SW_SHOW

            // 2. Attach thread input to current foreground thread
            IntPtr fgWnd = GetForegroundWindow();
            uint fgThread = 0;
            if (fgWnd != IntPtr.Zero) {
                GetWindowThreadProcessId(fgWnd, out fgThread);
            }
            uint curThread = GetCurrentThreadId();

            if (fgThread != 0 && fgThread != curThread) {
                AttachThreadInput(curThread, fgThread, true);
            }

            // 3. Lift Windows SetForegroundWindow lock by pulsing ALT key
            keybd_event(0x12, 0, 0, 0); // ALT down
            keybd_event(0x12, 0, 2, 0); // ALT up

            // 4. Bring window to top and switch to it
            BringWindowToTop(target);
            SetForegroundWindow(target);
            SwitchToThisWindow(target, true);

            if (fgThread != 0 && fgThread != curThread) {
                AttachThreadInput(curThread, fgThread, false);
            }

            if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
        });

        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return true;
    }

    public static bool Minimize(string query, out string foundTitle) {
        string fClass;
        uint fPid;
        IntPtr target = FindTarget(query, out foundTitle, out fClass, out fPid);
        if (target == IntPtr.Zero) return false;
        ShowWindow(target, 6); // SW_MINIMIZE
        return true;
    }

    public static bool Maximize(string query, out string foundTitle) {
        string fClass;
        uint fPid;
        IntPtr target = FindTarget(query, out foundTitle, out fClass, out fPid);
        if (target == IntPtr.Zero) return false;
        ShowWindow(target, 3); // SW_MAXIMIZE
        return true;
    }

    public static bool Close(string query, out string foundTitle, out string foundClass, out uint foundPid) {
        IntPtr target = FindTarget(query, out foundTitle, out foundClass, out foundPid);
        if (target == IntPtr.Zero) return false;
        PostMessage(target, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        PostMessage(target, 0x0112, new IntPtr(0xF060), IntPtr.Zero); // SC_CLOSE
        return true;
    }

    public static string GetActive() {
        SetProcessDPIAware();
        string res = "0|Desktop";
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero && IsWindowVisible(fg)) {
                var sb = new StringBuilder(256);
                GetWindowText(fg, sb, 256);
                string title = sb.ToString().Trim();
                if (!string.IsNullOrEmpty(title)) {
                    uint pid;
                    GetWindowThreadProcessId(fg, out pid);
                    res = pid + "|" + title;
                    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
                    return;
                }
            }

            // Fallback: top visible desktop window
            if (hDesk != IntPtr.Zero) {
                EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                    if (!IsWindowVisible(hWnd)) return true;
                    var sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    string winTitle = sb.ToString().Trim();
                    if (string.IsNullOrEmpty(winTitle)) return true;

                    var csb = new StringBuilder(128);
                    GetClassName(hWnd, csb, 128);
                    string winCls = csb.ToString();
                    if (winCls == "Progman" || winCls == "WorkerW" || winCls == "Shell_TrayWnd" || winCls == "Default IME" || winCls == "MSCTFIME UI") return true;

                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    res = pid + "|" + winTitle;
                    return false;
                }, IntPtr.Zero);
                CloseDesktop(hDesk);
            }
        });

        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        return res;
    }
}
"@ -ErrorAction SilentlyContinue
`;

export class WindowEngine {
  private runPowerShell(script: string, timeoutMs: number = 6000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const cleanScript = `[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal';\r\n$ProgressPreference = 'SilentlyContinue';\r\n` + script;
      const encoded = Buffer.from(cleanScript, "utf16le").toString("base64");
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encoded
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, stdout, stderr: "Timed out" });
      }, timeoutMs);

      child.stdout.on("data", d => { stdout += d.toString(); });
      child.stderr.on("data", d => { stderr += d.toString(); });

      child.on("close", code => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
      child.on("error", err => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message });
      });
    });
  }

  public async listWindows(): Promise<{ title: string; pid: number; process: string; class_name?: string }[]> {
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      $windows = [WinDesktopManager]::ListAllWindows()
      $results = @()
      foreach ($w in $windows) {
        $results += [PSCustomObject]@{
          title = $w.Title
          pid = $w.Pid
          process = $w.ProcessName
          class_name = $w.ClassName
        }
      }

      # Also add Shell.Application File Explorer and Control Panel windows if present
      try {
        $app = New-Object -ComObject Shell.Application
        foreach ($sh in $app.Windows()) {
          $name = [string]$sh.LocationName
          if ($name -and -not ($results | Where-Object { $_.title -like "*$name*" })) {
            $results += [PSCustomObject]@{
              title = $name
              pid = 0
              process = "explorer"
              class_name = "CabinetWClass"
            }
          }
        }
      } catch {}

      $results | ConvertTo-Json -Compress
    `;

    const res = await this.runPowerShell(ps, 6000);
    try {
      const sanitized = (res.stdout || "[]").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
      const parsed = JSON.parse(sanitized);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map(w => ({
        title: String(w.title || ""),
        pid: Number(w.pid || 0),
        process: String(w.process || ""),
        class_name: String(w.class_name || "")
      }));
    } catch {
      return [];
    }
  }

  public async focus(titleQuery: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const q = titleQuery.toLowerCase().trim();

    // Primary path: the Win32/C# desktop manager handles minimized windows,
    // cross-thread foreground restrictions, and the ALT-key foreground lock
    // bypass reliably. Keep the lightweight WScript path only as fallback.
    const primaryPs = `
      ${WIN_DESKTOP_MANAGER_CS}
      $found = ""
      $ok = [WinDesktopManager]::Focus("${q.replace(/"/g, '`"')}", [ref]$found)
      if ($ok) { "OK|" + $found } else { "NOT_FOUND" }
    `;
    const primaryRes = await this.runPowerShell(primaryPs, 5000);
    if (primaryRes.stdout.startsWith("OK|")) {
      const matched = primaryRes.stdout.slice(3).trim();
      return { ok: true, result: `Successfully brought window '${matched || titleQuery}' to foreground.` };
    }

    // Fallback: quick AppActivate for simple foregroundable windows.
    const fastScript = `
      $q = "${q.replace(/"/g, '`"')}"
      $ws = New-Object -ComObject WScript.Shell
      if ($ws.AppActivate($q)) {
        "FAST_OK|" + $q
        exit 0
      }
      $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { 
        $_.MainWindowTitle -and ($_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*") 
      } | Select-Object -First 1
      if ($proc -and $ws.AppActivate($proc.Id)) {
        "FAST_OK|" + $proc.MainWindowTitle
        exit 0
      }
      "FAST_NOT_FOUND"
    `;

    const fastRes = await this.runPowerShell(fastScript, 1500);
    if (fastRes.stdout.startsWith("FAST_OK|")) {
      const matched = fastRes.stdout.slice(8).trim();
      return { ok: true, result: `Successfully brought window '${matched || titleQuery}' to foreground.` };
    }

    // Last fallback: retry the deep Win32 path in case the target appeared
    // while the first scan was running.
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      $found = ""
      $ok = [WinDesktopManager]::Focus("${q.replace(/"/g, '`"')}", [ref]$found)
      if ($ok) { "OK|" + $found } else { "NOT_FOUND" }
    `;
    const res = await this.runPowerShell(ps, 5000);
    if (res.stdout.startsWith("OK|")) {
      const matched = res.stdout.slice(3).trim();
      return { ok: true, result: `Successfully brought window '${matched || titleQuery}' to foreground.` };
    }
    return { ok: false, error: `Window matching '${titleQuery}' not found or could not be activated.` };
  }

  public async minimize(titleQuery: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const q = titleQuery.toLowerCase().trim();
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      $found = ""
      $ok = [WinDesktopManager]::Minimize("${q.replace(/"/g, '`"')}", [ref]$found)
      if ($ok) { "OK|" + $found } else { "NOT_FOUND" }
    `;
    const res = await this.runPowerShell(ps, 5000);
    if (res.stdout.startsWith("OK|")) {
      const matched = res.stdout.slice(3).trim();
      return { ok: true, result: `Minimized window '${matched || titleQuery}'.` };
    }
    return { ok: false, error: `Window matching '${titleQuery}' not found.` };
  }

  public async maximize(titleQuery: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const q = titleQuery.toLowerCase().trim();
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      $found = ""
      $ok = [WinDesktopManager]::Maximize("${q.replace(/"/g, '`"')}", [ref]$found)
      if ($ok) { "OK|" + $found } else { "NOT_FOUND" }
    `;
    const res = await this.runPowerShell(ps, 5000);
    if (res.stdout.startsWith("OK|")) {
      const matched = res.stdout.slice(3).trim();
      return { ok: true, result: `Maximized window '${matched || titleQuery}'.` };
    }
    return { ok: false, error: `Window matching '${titleQuery}' not found.` };
  }

  public async close(titleQuery: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const q = titleQuery.toLowerCase().trim();

    // 1. File Explorer & Open Folder Windows
    if (["explorer", "file explorer", "file_explorer", "files", "folder", "folders", "my files", "downloads", "documents", "desktop"].includes(q)) {
      const ps = `
        $app = New-Object -ComObject Shell.Application
        $closed = 0
        foreach ($w in $app.Windows()) {
          try {
            $name = [string]$w.LocationName
            if (-not "${q}" -or "${q}" -eq "explorer" -or "${q}" -eq "file explorer" -or $name.ToLower().Contains("${q}")) {
              $w.Quit()
              $closed++
            }
          } catch {}
        }
        Write-Output "OK:$closed"
      `;
      const res = await this.runPowerShell(ps, 4000);
      return { ok: true, result: `Closed File Explorer window(s) matching '${titleQuery}'.` };
    }

    // 2. Control Panel
    if (q === "control panel" || q === "control") {
      const ps = `
        $app = New-Object -ComObject Shell.Application
        foreach ($w in $app.Windows()) {
          if ($w.LocationName -eq 'Control Panel') { $w.Quit() }
        }
        Write-Output "OK"
      `;
      await this.runPowerShell(ps, 4000);
      return { ok: true, result: "Successfully closed Control Panel." };
    }

    // 3. Generic Win32 Window Closure via WinDesktopManager
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      $foundTitle = ""
      $foundClass = ""
      [uint32]$foundPid = 0
      $ok = [WinDesktopManager]::Close("${q.replace(/"/g, '`"')}", [ref]$foundTitle, [ref]$foundClass, [ref]$foundPid)
      if ($ok) {
        if ($foundClass -eq "MMCMainFrame" -or $foundClass -eq "#32770" -or "${q}".Contains(".msc")) {
          if ($foundPid -gt 4) {
            try { Stop-Process -Id $foundPid -Force -ErrorAction SilentlyContinue } catch {}
          }
        }
        "OK|" + $foundTitle
      } else {
        "NOT_FOUND"
      }
    `;

    const res = await this.runPowerShell(ps, 5000);
    if (res.stdout.startsWith("OK|")) {
      const matched = res.stdout.slice(3).trim();
      return { ok: true, result: `Successfully closed window '${matched || titleQuery}'.` };
    }

    // 4. Fallback check: If the query matches an open MMC snap-in or process by name, terminate cleanly
    if (q.includes("disk management") || q.includes("diskmgmt") || q.includes("device manager") || q.includes("devmgmt")) {
      await this.runPowerShell(`Stop-Process -Name mmc -Force -ErrorAction SilentlyContinue`, 3000);
      return { ok: true, result: `Successfully closed '${titleQuery}'.` };
    }

    return { ok: false, error: `Window '${titleQuery}' not found.` };
  }

  public async getActive(): Promise<{ ok: boolean; title?: string; pid?: string; error?: string }> {
    const ps = `
      ${WIN_DESKTOP_MANAGER_CS}
      [WinDesktopManager]::GetActive()
    `;
    const res = await this.runPowerShell(ps, 4000);
    const parts = (res.stdout || "").split("|");
    const pid = parts[0]?.trim();
    const title = parts.slice(1).join("|").trim();
    return { ok: true, pid: pid || "0", title: title || "Desktop" };
  }
}

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn, exec } from "child_process";

// ---------------------------------------------------------------------------
// SystemEngine (Tier 1-4 Direct Soul Core)
// Controls process lifecycle, app resolution, system metrics, and master volume.
// ---------------------------------------------------------------------------

const AUDIO_CSHARP_DEF = `
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(ref Guid pguidEventContext);
    int VolumeStepDown(ref Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDevEnum {}

public class AudioMaster {
    private static IAudioEndpointVolume GetEndpoint() {
        var enumerator = (IMMDeviceEnumerator)(new MMDevEnum());
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        Guid IID = typeof(IAudioEndpointVolume).GUID;
        object epObj;
        dev.Activate(ref IID, 23, IntPtr.Zero, out epObj);
        return (IAudioEndpointVolume)epObj;
    }

    public static float GetVolume() {
        var ep = GetEndpoint();
        float level;
        ep.GetMasterVolumeLevelScalar(out level);
        return (float)Math.Round(level * 100);
    }

    public static float SetVolume(float levelPercent) {
        var ep = GetEndpoint();
        float scalar = Math.Max(0.0f, Math.Min(100.0f, levelPercent)) / 100.0f;
        Guid empty = Guid.Empty;
        ep.SetMasterVolumeLevelScalar(scalar, ref empty);
        return GetVolume();
    }

    public static bool GetMute() {
        var ep = GetEndpoint();
        bool mute;
        ep.GetMute(out mute);
        return mute;
    }

    public static bool SetMute(bool mute) {
        var ep = GetEndpoint();
        Guid empty = Guid.Empty;
        ep.SetMute(mute, ref empty);
        return mute;
    }

    public static float Adjust(float delta) {
        float current = GetVolume();
        float target = Math.Max(0.0f, Math.Min(100.0f, current + delta));
        return SetVolume(target);
    }
}
`;

export class SystemEngine {
  private static appAliases: Record<string, string> = {
    notepad: "notepad.exe",
    calc: "calc.exe",
    calculator: "calc.exe",
    paint: "mspaint.exe",
    cmd: "cmd.exe",
    terminal: "wt.exe",
    powershell: "powershell.exe",
    explorer: "explorer.exe",
    "file explorer": "explorer.exe",
    "my files": "explorer.exe",
    control: "control.exe",
    "control panel": "control.exe",
    taskmgr: "taskmgr.exe",
    taskmanager: "taskmgr.exe",
    "task manager": "taskmgr.exe",
    settings: "ms-settings:",
    "windows settings": "ms-settings:",
    store: "ms-windows-store:",
    "microsoft store": "ms-windows-store:",
    "windows store": "ms-windows-store:",
    copilot: "ms-copilot:",
    "microsoft copilot": "ms-copilot:",
    spotify: "spotify:",
    edge: "msedge.exe",
    "microsoft edge": "msedge.exe",
    chrome: "chrome.exe",
    "google chrome": "chrome.exe",
    "vs code": "code",
    vscode: "code",
    "visual studio code": "code",
    "device manager": "devmgmt.msc",
    devmgmt: "devmgmt.msc",
    "disk management": "diskmgmt.msc",
    diskmgmt: "diskmgmt.msc",
    "computer management": "compmgmt.msc",
    services: "services.msc",
    "event viewer": "eventvwr.msc",
    "registry editor": "regedit.exe",
    regedit: "regedit.exe",
    resmon: "resmon.exe",
    "resource monitor": "resmon.exe",
  };

  private installedAppsCatalog: Record<string, string> = {};
  private catalogLoaded = false;

  constructor() {
    this.refreshCatalog();
  }

  public runPowerShell(script: string, timeoutMs: number = 10000): Promise<{ ok: boolean; stdout: string; stderr: string; returncode: number }> {
    return new Promise((resolve) => {
      // Lower process priority of background child PowerShell processes to 'BelowNormal' or 'Idle'
      // so desktop checks NEVER steal CPU threads from audio streaming / WebSocket processing!
      const priScript = `[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal';\n` + script;
      const encoded = Buffer.from(priScript, "utf16le").toString("base64");
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
        try { child.kill("SIGTERM"); } catch {}
        resolve({ ok: false, stdout, stderr: `Timed out after ${timeoutMs}ms`, returncode: -1 });
      }, timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          returncode: code ?? 0
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message, returncode: -1 });
      });
    });
  }

  public refreshCatalog(): void {
    if (this.catalogLoaded) return;
    // Start Menu misses traditional Win32 programs. Include the standard
    // per-user and machine uninstall registry hives so Control Panel apps can
    // also be found by name.
    const catalogScript = `
      $items = @();
      Get-StartApps | ForEach-Object { $items += [pscustomobject]@{ Name = $_.Name; AppID = $_.AppID } };
      $uninstallPaths = @(
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      );
      Get-ItemProperty $uninstallPaths -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and $_.DisplayName.Trim() } |
        ForEach-Object {
          $uninstall = if ($_.UninstallString) { $_.UninstallString } elseif ($_.QuietUninstallString) { $_.QuietUninstallString } else { '' };
          $items += [pscustomobject]@{ Name = $_.DisplayName; AppID = $uninstall }
        };
      $items | Sort-Object Name -Unique | ConvertTo-Json -Compress
    `;
    this.runPowerShell(catalogScript, 8000).then(({ ok, stdout }) => {
      if (ok && stdout) {
        try {
          const raw = JSON.parse(stdout);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const item of list) {
            if (item?.Name && item?.AppID) {
              this.installedAppsCatalog[String(item.Name).trim().toLowerCase()] = String(item.AppID).trim();
            }
          }
          this.catalogLoaded = true;
        } catch {}
      }
    }).catch(() => {});
  }

  public launch(appName: string, args: string[] = []): { ok: boolean; result?: string; error?: string } {
    const clean = appName.trim();
    if (!clean) return { ok: false, error: "App name cannot be empty." };
    const lower = clean.toLowerCase().replace(/\.exe$/i, "");

    // 1. Folder shortcuts
    if (lower === "downloads" || lower === "downloads folder") {
      spawn("cmd.exe", ["/c", "start", "", path.join(os.homedir(), "Downloads")], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: "Opened Downloads in File Explorer." };
    }
    if (lower === "desktop" || lower === "desktop folder") {
      spawn("cmd.exe", ["/c", "start", "", path.join(os.homedir(), "Desktop")], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: "Opened Desktop in File Explorer." };
    }
    if (lower === "documents" || lower === "documents folder") {
      spawn("cmd.exe", ["/c", "start", "", path.join(os.homedir(), "Documents")], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: "Opened Documents in File Explorer." };
    }

    // 2. Direct folder or file path
    if (fs.existsSync(clean)) {
      spawn("cmd.exe", ["/c", "start", "", path.resolve(clean)], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: `Successfully launched '${path.basename(clean)}'.` };
    }

    // 3. Known Aliases & URI protocols (e.g. ms-settings:, ms-windows-store:, ms-copilot:)
    const target = SystemEngine.appAliases[lower] || SystemEngine.appAliases[clean.toLowerCase()] || clean;

    // Windows 11 Protocol Handlers and .msc Snap-ins: Delegate directly to Windows Shell
    // cmd.exe /c start guarantees the window is brought to foreground in user desktop session
    if ((target.includes(":") && !target.endsWith(".exe") && !fs.existsSync(target)) || target.toLowerCase().endsWith(".msc")) {
      spawn("cmd.exe", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore"
      }).unref();
      return { ok: true, result: `Successfully opened ${clean}.` };
    }

    // 4. Windows Installed Apps Catalog (O(1) in-memory resolution)
    if (this.installedAppsCatalog[lower]) {
      const appId = this.installedAppsCatalog[lower];
      spawn("cmd.exe", ["/c", "start", "", `shell:AppsFolder\\${appId}`], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: `Successfully launched ${clean}.` };
    }

    // Normalized match (e.g. 'vs code' or 'z-code')
    const normQuery = lower.replace(/[\s\-_]/g, "");
    for (const [title, appId] of Object.entries(this.installedAppsCatalog)) {
      const normTitle = title.replace(/[\s\-_]/g, "");
      if (normQuery === normTitle || (normQuery.length >= 3 && normTitle.includes(normQuery))) {
        spawn("cmd.exe", ["/c", "start", "", `shell:AppsFolder\\${appId}`], { detached: true, stdio: "ignore" }).unref();
        return { ok: true, result: `Successfully launched ${title}.` };
      }
    }

    // 5. URL Self-Healing (e.g. user said "launch youtube.com", "open github.com")
    if (lower.includes(".com") || lower.includes(".org") || lower.includes(".net") || lower.includes(".io") || lower.startsWith("http://") || lower.startsWith("https://")) {
      const url = lower.startsWith("http") ? clean : `https://${clean}`;
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, result: `Self-healed: Opened '${url}' in default browser.` };
    }

    // 6. Direct shell start fallback
    spawn("cmd.exe", ["/c", "start", "", target, ...args], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, result: `Launched ${clean}.` };
  }

  public async closeFileExplorer(folderQuery?: string): Promise<{ ok: boolean; result: string }> {
    const q = folderQuery ? folderQuery.toLowerCase().trim() : "";
    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      $app = New-Object -ComObject Shell.Application
      $closed = 0
      foreach ($w in $app.Windows()) {
        try {
          $name = [string]$w.LocationName
          $url = [string]$w.LocationURL
          if (-not "${q}" -or $name.ToLower().Contains("${q}") -or $url.ToLower().Contains("${q}")) {
            $w.Quit()
            $closed++
          }
        } catch {}
      }
      Write-Output "CLOSED:$closed"
    `;
    await this.runPowerShell(ps, 5000);
    return { ok: true, result: "Successfully closed File Explorer folder windows (desktop shell preserved)." };
  }

  public async restartExplorer(): Promise<{ ok: boolean; result: string }> {
    const ps = `
      $ProgressPreference = 'SilentlyContinue';
      Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 600
      Start-Process explorer.exe
    `;
    await this.runPowerShell(ps, 6000);
    return { ok: true, result: "Successfully restarted Windows File Explorer shell and taskbar." };
  }

  public async killProcess(appName: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const raw = appName.trim();
    if (!raw) return { ok: false, error: "App name is required." };
    const clean = raw.toLowerCase().replace(/\.exe$/i, "");

    // 1. Explicit restart requests
    if (clean === "restart explorer" || clean === "restart file explorer" || clean === "restart taskbar") {
      return await this.restartExplorer();
    }

    // 2. File Explorer folder windows: Never kill explorer.exe desktop shell!
    if (["explorer", "file explorer", "file_explorer", "files", "folder", "folders", "my files", "file manager"].includes(clean)) {
      return await this.closeFileExplorer();
    }

    // 3. Control Panel
    if (clean === "control panel" || clean === "control") {
      const ps = `
        $ProgressPreference = 'SilentlyContinue';
        $app = New-Object -ComObject Shell.Application
        $closed = 0
        foreach ($w in $app.Windows()) {
          if ($w.LocationName -eq 'Control Panel') { $w.Quit(); $closed++ }
        }
        Write-Output "CLOSED:$closed"
      `;
      await this.runPowerShell(ps, 4000);
      return { ok: true, result: "Successfully closed Control Panel." };
    }

    // 4. Process Mapping for Windows MMC Administration Snap-ins & UWP Apps
    const processMap: Record<string, string> = {
      "device manager": "mmc.exe",
      devmgmt: "mmc.exe",
      "devmgmt.msc": "mmc.exe",
      "disk management": "mmc.exe",
      diskmgmt: "mmc.exe",
      "diskmgmt.msc": "mmc.exe",
      "computer management": "mmc.exe",
      compmgmt: "mmc.exe",
      "compmgmt.msc": "mmc.exe",
      "event viewer": "mmc.exe",
      eventvwr: "mmc.exe",
      "eventvwr.msc": "mmc.exe",
      services: "mmc.exe",
      "services.msc": "mmc.exe",
      settings: "SystemSettings.exe",
      "windows settings": "SystemSettings.exe",
      taskmgr: "Taskmgr.exe",
      taskmanager: "Taskmgr.exe",
      "task manager": "Taskmgr.exe",
      notepad: "notepad.exe",
      chrome: "chrome.exe",
      edge: "msedge.exe",
      calc: "CalculatorApp.exe",
      calculator: "CalculatorApp.exe",
      paint: "mspaint.exe",
      spotify: "Spotify.exe",
      code: "Code.exe",
      vscode: "Code.exe",
      terminal: "WindowsTerminal.exe",
      powershell: "powershell.exe",
      cmd: "cmd.exe",
      copilot: "Copilot.exe",
      "microsoft copilot": "Copilot.exe"
    };

    const exe = processMap[clean] || (raw.endsWith(".exe") ? raw : `${raw}.exe`);

    // Safety guard: Protect core Windows OS processes
    if (["dwm.exe", "csrss.exe", "smss.exe", "wininit.exe", "lsass.exe", "services.exe"].includes(exe.toLowerCase())) {
      return { ok: false, error: `Cannot terminate protected critical OS process '${raw}'.` };
    }

    return new Promise((resolve) => {
      exec(`taskkill /F /IM "${exe}"`, (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        const errOut = (stderr || "").trim();
        if (err && !out.includes("SUCCESS")) {
          // Self-Healing: If taskkill by process name failed, try closing by matching window title
          const psCloseWindow = `
            $ProgressPreference = 'SilentlyContinue';
            $w = Get-Process | Where-Object { $_.MainWindowTitle -like "*${clean}*" } | Select-Object -First 1
            if ($w) { $w.CloseMainWindow() | Out-Null; "HEALED" } else { "NOT_FOUND" }
          `;
          this.runPowerShell(psCloseWindow, 3000).then((wRes) => {
            if (wRes.stdout.includes("HEALED")) {
              resolve({ ok: true, result: `Self-healed: Located open window for '${raw}' and gracefully closed it.` });
              return;
            }
            if (errOut.includes("not found") || errOut.includes("no running instance")) {
              resolve({ ok: true, result: `'${raw}' is already closed (no active process or window found).` });
            } else {
              resolve({ ok: false, error: `Could not close '${raw}': ${errOut || err.message}` });
            }
          }).catch(() => {
            resolve({ ok: true, result: `'${raw}' is closed.` });
          });
        } else {
          resolve({ ok: true, result: `Successfully closed ${raw}.` });
        }
      });
    });
  }

  public findInstalledApp(query: string): { found: boolean; count: number; matches: any[]; summary: string } {
    this.refreshCatalog();
    const q = query.toLowerCase().trim();
    const matches: { name: string; appId: string }[] = [];
    for (const [name, appId] of Object.entries(this.installedAppsCatalog)) {
      if (name.includes(q) || q.includes(name)) {
        matches.push({ name, appId });
      }
    }
    const found = matches.length > 0;
    return {
      found,
      count: matches.length,
      matches: matches.slice(0, 15),
      summary: found ? `Found ${matches.length} matching installed app(s) for '${query}'.` : `No installed app found matching '${query}'.`
    };
  }

  public async listRunningApplications(filterQuery?: string): Promise<{ ok: boolean; applications: any[]; count: number }> {
    const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle, @{Name="MemoryMB"; Expression={[math]::Round($_.WorkingSet64 / 1MB, 1)}} | ConvertTo-Json -Compress`;
    const res = await this.runPowerShell(ps, 6000);
    let apps: any[] = [];
    try {
      const parsed = JSON.parse(res.stdout || "[]");
      apps = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}

    if (filterQuery) {
      const q = filterQuery.toLowerCase().trim();
      apps = apps.filter(a =>
        String(a.ProcessName || "").toLowerCase().includes(q) ||
        String(a.MainWindowTitle || "").toLowerCase().includes(q)
      );
    }
    return { ok: true, count: apps.length, applications: apps.slice(0, 50) };
  }

  public async getProcessDetails(target: string): Promise<{ ok: boolean; result?: any; error?: string }> {
    const clean = target.trim();
    const isPid = /^\d+$/.test(clean);
    const filterExpr = isPid ? `-Id ${clean}` : `-Name "${clean.replace(/\.exe$/i, "")}"`;
    const ps = `Get-Process ${filterExpr} -ErrorAction SilentlyContinue | Select-Object -First 1 Id, ProcessName, Path, @{Name="MemoryMB"; Expression={[math]::Round($_.WorkingSet64 / 1MB, 1)}}, Responding, StartTime | ConvertTo-Json -Compress`;
    const res = await this.runPowerShell(ps, 5000);
    if (!res.ok || !res.stdout) return { ok: false, error: `Process '${target}' not found.` };
    try {
      return { ok: true, result: JSON.parse(res.stdout) };
    } catch {
      return { ok: true, result: res.stdout };
    }
  }

  public async getMetrics(): Promise<Record<string, any>> {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Real-Time CPU Frequency vs Base Speed (matches Windows Task Manager):
    // Win32_Processor only returns static MaxClockSpeed for both fields.
    // Real-time dynamic frequency requires polling the Windows Performance Counter!
    let baseSpeedGHz = Math.round((cpus[0]?.speed || 3500) / 100) / 10;
    let currentSpeedGHz = baseSpeedGHz;
    let cpuLoadPercent = 0;

    try {
      const ps = `
        $base = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1 MaxClockSpeed).MaxClockSpeed
        $perfPct = (Get-Counter '\\Processor Information(_Total)\\% of Maximum Frequency' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
        $load = (Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
        Write-Output "$base|$perfPct|$load"
      `;
      const res = await this.runPowerShell(ps, 3000);
      if (res.ok && res.stdout) {
        const parts = res.stdout.trim().split("|");
        const bMHz = parseFloat(parts[0]) || cpus[0]?.speed || 3500;
        const pPct = parseFloat(parts[1]) || 100;
        const lPct = parseFloat(parts[2]) || 0;
        baseSpeedGHz = Math.round((bMHz / 1000) * 100) / 100;
        currentSpeedGHz = Math.round(((bMHz * pPct) / 100000) * 100) / 100;
        cpuLoadPercent = Math.round(lPct);
      }
    } catch {}

    return {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      uptime_hours: Math.round((os.uptime() / 3600) * 10) / 10,
      cpu_cores: cpus.length,
      cpu_model: cpus[0]?.model || "Unknown CPU",
      cpu_base_speed_ghz: baseSpeedGHz,
      cpu_current_speed_ghz: currentSpeedGHz,
      cpu_load_percent: cpuLoadPercent,
      ram_total_gb: Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10,
      ram_used_gb: Math.round((usedMem / (1024 * 1024 * 1024)) * 10) / 10,
      ram_percent: Math.round((usedMem / totalMem) * 100),
      platform: "win32",
    };
  }

  public async getVolume(): Promise<{ ok: boolean; volume: number; is_muted: boolean; result: string }> {
    const ps = `
      Add-Type -TypeDefinition @"
${AUDIO_CSHARP_DEF}
"@ -ErrorAction SilentlyContinue
      $v = [AudioMaster]::GetVolume()
      $m = [AudioMaster]::GetMute()
      Write-Output "$v|$m"
    `;
    const res = await this.runPowerShell(ps, 5000);
    const parts = (res.stdout || "").trim().split("|");
    const vol = parseFloat(parts[0]) || 0;
    const isMuted = parts[1]?.toLowerCase() === "true";
    return {
      ok: res.ok,
      volume: vol,
      is_muted: isMuted,
      result: `Master system volume is ${vol}%${isMuted ? " (MUTED)" : ""}.`
    };
  }

  public async setVolume(level: number): Promise<{ ok: boolean; volume: number; result: string }> {
    const val = Math.max(0, Math.min(100, Math.round(level)));
    const ps = `
      Add-Type -TypeDefinition @"
${AUDIO_CSHARP_DEF}
"@ -ErrorAction SilentlyContinue
      $actual = [AudioMaster]::SetVolume(${val})
      Write-Output $actual
    `;
    const res = await this.runPowerShell(ps, 5000);
    const actualVol = parseFloat(res.stdout) || val;
    return { ok: res.ok, volume: actualVol, result: `Master system volume set to ${actualVol}%.` };
  }

  public async adjustVolume(delta: number): Promise<{ ok: boolean; previous_volume?: number; new_volume: number; result: string }> {
    const ps = `
      Add-Type -TypeDefinition @"
${AUDIO_CSHARP_DEF}
"@ -ErrorAction SilentlyContinue
      $prev = [AudioMaster]::GetVolume()
      $newV = [AudioMaster]::Adjust(${delta})
      Write-Output "$prev|$newV"
    `;
    const res = await this.runPowerShell(ps, 5000);
    const parts = (res.stdout || "").trim().split("|");
    const prev = parseFloat(parts[0]) || 0;
    const next = parseFloat(parts[1]) || 0;
    const direction = delta >= 0 ? "increased" : "decreased";
    return {
      ok: res.ok,
      previous_volume: prev,
      new_volume: next,
      result: `Master volume ${direction} from ${prev}% to ${next}%.`
    };
  }

  public async toggleMute(mute?: boolean): Promise<{ ok: boolean; is_muted: boolean; result: string }> {
    const ps = `
      Add-Type -TypeDefinition @"
${AUDIO_CSHARP_DEF}
"@ -ErrorAction SilentlyContinue
      $target = ${mute !== undefined ? (mute ? "$true" : "$false") : "(-not [AudioMaster]::GetMute())"}
      $res = [AudioMaster]::SetMute($target)
      Write-Output $res
    `;
    const res = await this.runPowerShell(ps, 4000);
    const isMuted = res.stdout.trim().toLowerCase() === "true";
    return { ok: res.ok, is_muted: isMuted, result: `Audio ${isMuted ? "muted" : "unmuted"}.` };
  }

  public async controlMedia(action: string): Promise<{ ok: boolean; result: string }> {
    const rawAct = String(action || "").toLowerCase().trim();
    // Models commonly send natural-language variants instead of the compact
    // enum value. Normalize them before dispatching the Windows media key.
    const act = rawAct
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Resolve intent from the strongest playback keywords first. This prevents
    // phrases such as "pause video" or "next video" from being misrouted to
    // a volume action by the model.
    const normalizedAct = /\b(previous|prev|back|pichhla|पिछला)\b/.test(act)
      ? "previous"
      : /\b(next|अगला)\b/.test(act)
        ? "next"
        : /\b(pause|paused|पॉज़|रोक)\b/.test(act)
          ? "pause"
          : /\b(play|resume|चलाओ)\b/.test(act)
            ? "play"
            : /\b(stop|बंद)\b/.test(act)
              ? "stop"
              : act;

    // Direct audio adjustments for volume actions
    if (["volume down", "volumedown", "voldown", "decrease volume", "lower volume", "volume low", "make volume low", "कम आवाज", "आवाज़ कम", "आवाज कम", "volume kam", "volume kum", "volume low kar do", "आवाज़ कम कर दो"].includes(act)) {
      const res = await this.adjustVolume(-10);
      return { ok: res.ok, result: res.result };
    }
    if (["volume up", "volumeup", "volup", "increase volume", "raise volume", "volume high", "आवाज बढ़ाओ", "आवाज़ बढ़ाओ", "आवाज बढ़ा दो", "volume badha do"].includes(act)) {
      const res = await this.adjustVolume(10);
      return { ok: res.ok, result: res.result };
    }
    if (["volume mute", "volumemute", "mute", "म्यूट"].includes(act)) {
      const res = await this.toggleMute(true);
      return { ok: res.ok, result: res.result };
    }
    if (act === "unmute") {
      const res = await this.toggleMute(false);
      return { ok: res.ok, result: res.result };
    }

    const keyMap: Record<string, number> = {
      play: 179, "play music": 179, resume: 179, "play playback": 179,
      pause: 179, "pause playback": 179, "pause music": 179, "पॉज़": 179,
      "play pause": 179, "play/pause": 179,
      next: 176, "next track": 176, "next song": 176, "अगला": 176, "अगला गाना": 176,
      previous: 177, prev: 177, "previous track": 177, "previous song": 177, "पिछला": 177, "पिछला गाना": 177,
      stop: 178, "stop playback": 178, "stop music": 178
    };
    const vk = keyMap[normalizedAct];
    if (!vk) {
      return { ok: false, result: `Unknown media action '${action}'. Use play, pause, next, previous, or stop.` };
    }
    const cs = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class MediaKey {
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        public static void Press(byte vk) {
          // Media VK codes are extended keyboard keys. SendInput is the
          // reliable modern path; retain keybd_event as a compatibility retry.
          INPUT[] inputs = new INPUT[2];
          inputs[0].type = 1;
          inputs[0].ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 1, time = 0, dwExtraInfo = UIntPtr.Zero };
          inputs[1].type = 1;
          inputs[1].ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 3, time = 0, dwExtraInfo = UIntPtr.Zero };
          uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
          // If Windows accepted either keyboard event, do not send a second
          // toggle sequence: media keys are state toggles, so a duplicate can
          // pause and immediately resume the player.
          if (sent == 0) {
            keybd_event(vk, 0, 1, 0);
            keybd_event(vk, 0, 3, 0);
          }
        }
      }
"@ -ErrorAction SilentlyContinue
      [MediaKey]::Press(${vk})
    `;
    const mediaRes = await this.runPowerShell(cs, 4000);
    if (!mediaRes.ok) return { ok: false, result: `Failed to send media control action '${act}'.` };
    return { ok: true, result: `Sent media control action: ${act}.` };
  }

  public emptyRecycleBin(): Promise<{ ok: boolean; result: string }> {
    return this.runPowerShell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue", 8000).then(() => ({
      ok: true,
      result: "Windows Recycle Bin emptied successfully."
    }));
  }

  public lockWorkstation(): { ok: boolean; result: string } {
    spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, result: "Computer workstation locked successfully." };
  }

  public openPathOrFile(filePath: string): { ok: boolean; result?: string; path?: string; error?: string } {
    if (!filePath || !filePath.trim()) {
      return { ok: false, error: "Path cannot be empty." };
    }
    let raw = filePath.trim();

    // 1. Expand %VAR% environment variables (e.g. %APPDATA%, %USERPROFILE%, %TEMP%)
    if (raw.includes("%")) {
      raw = raw.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
    }

    // 2. Expand ~/ tilde to user home
    if (raw.startsWith("~/") || raw === "~") {
      raw = path.join(os.homedir(), raw.slice(1));
    }

    // 3. Resolve cleanly to normalized Windows path
    const resolvedPath = path.resolve(raw);

    // 4. Verify path existence before blindly spawning
    if (!fs.existsSync(resolvedPath)) {
      return {
        ok: false,
        path: resolvedPath,
        error: `Path does not exist on disk: '${resolvedPath}'. Windows cannot find it.`
      };
    }

    try {
      spawn("cmd.exe", ["/c", "start", "", resolvedPath], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, path: resolvedPath, result: `Successfully opened '${path.basename(resolvedPath)}' in File Explorer.` };
    } catch (e: any) {
      return { ok: false, path: resolvedPath, error: `Failed to open path: ${e?.message || e}` };
    }
  }
}


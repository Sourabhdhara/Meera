import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { dataFile } from "../../server_paths";

// ---------------------------------------------------------------------------
// CompanionEngine (Tier 1-4 Reminders, Purple Popup Window & Action Center Toasts)
// Provides in-memory & persistent scheduled reminders, custom Catppuccin purple
// desktop popup cards (WPF), Windows Action Center toasts, and display brightness.
// ---------------------------------------------------------------------------

export interface ActiveReminder {
  id: string;
  message: string;
  title: string;
  minutes: number;
  dueAt: number;
  timer?: NodeJS.Timeout;
}

const POPUP_SCRIPT_CONTENT = `param(
    [string]$Title = "MEERA",
    [string]$Message = "Hello from MEERA!",
    [int]$DurationSec = 6
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

try {
    [System.Media.SystemSounds]::Asterisk.Play()
} catch {}

$displayTitle = $Title.Trim()
if (-not ($displayTitle -match '^[\\p{So}\\p{Sk}\\p{Cs}\\p{Cn}\\p{Co}\\u2700-\\u27BF\\uE000-\\uF8FF]')) {
    $displayTitle = "✨ $displayTitle"
}

$cleanTitle = [System.Security.SecurityElement]::Escape($displayTitle)
$cleanMessage = [System.Security.SecurityElement]::Escape($Message.Trim())

$xamlString = @"
<Window
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="MEERA Notification"
    WindowStyle="None"
    AllowsTransparency="True"
    Background="Transparent"
    Topmost="True"
    ShowInTaskbar="False"
    SizeToContent="WidthAndHeight"
    ResizeMode="NoResize">
    <Border Background="#181825"
            BorderBrush="#89b4fa"
            BorderThickness="2"
            CornerRadius="14"
            Padding="18,14,18,14"
            MaxWidth="440"
            MinWidth="340">
        <Border.Effect>
            <DropShadowEffect Color="#000000" BlurRadius="24" ShadowDepth="4" Opacity="0.6"/>
        </Border.Effect>
        <StackPanel Orientation="Vertical">
            <DockPanel LastChildFill="False" Margin="0,0,0,8">
                <TextBlock DockPanel.Dock="Left"
                           Text="$cleanTitle"
                           FontFamily="Segoe UI"
                           FontSize="14"
                           FontWeight="Bold"
                           Foreground="#cba6f7"/>
                <TextBlock x:Name="BtnClose"
                           DockPanel.Dock="Right"
                           Text="✕"
                           FontFamily="Segoe UI"
                           FontSize="12"
                           FontWeight="Bold"
                           Foreground="#6c7086"
                           Cursor="Hand"
                           Padding="12,0,0,0"/>
            </DockPanel>
            <TextBlock Text="$cleanMessage"
                       FontFamily="Segoe UI"
                       FontSize="13"
                       Foreground="#cdd6f4"
                       TextWrapping="Wrap"
                       LineHeight="18"/>
        </StackPanel>
    </Border>
</Window>
"@

try {
    $stringReader = New-Object System.IO.StringReader($xamlString)
    $xmlReader = [System.Xml.XmlReader]::Create($stringReader)
    $window = [System.Windows.Markup.XamlReader]::Load($xmlReader)

    $btnClose = $window.FindName("BtnClose")
    $btnClose.Add_MouseDown({
        $window.Close()
    })
    $btnClose.Add_MouseEnter({
        $btnClose.Foreground = [System.Windows.Media.Brushes]::IndianRed
    })
    $btnClose.Add_MouseLeave({
        $btnClose.Foreground = (New-Object System.Windows.Media.BrushConverter).ConvertFromString("#6c7086")
    })

    $workArea = [System.Windows.SystemParameters]::WorkArea
    $window.Add_Loaded({
        $window.Left = $workArea.Right - $window.ActualWidth - 24
        $window.Top = $workArea.Bottom - $window.ActualHeight - 24
    })

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds($DurationSec)
    $timer.Add_Tick({
        $timer.Stop()
        $window.Close()
    })
    $timer.Start()

    $window.ShowDialog() | Out-Null
} catch {}
`;

export class CompanionEngine {
  private activeReminders = new Map<string, ActiveReminder>();
  private popupScriptPath: string;
  private remindersFilePath: string;

  constructor() {
    this.popupScriptPath = dataFile("popup.ps1");
    this.remindersFilePath = dataFile("reminders.json");
    this.ensurePopupScript();
    this.loadReminders();
  }

  private ensurePopupScript(): void {
    try {
      if (!fs.existsSync(this.popupScriptPath)) {
        const localDist = path.join(__dirname, "popup.ps1");
        const localSrc = path.resolve("server/desktop/core/popup.ps1");
        if (fs.existsSync(localDist)) {
          fs.copyFileSync(localDist, this.popupScriptPath);
        } else if (fs.existsSync(localSrc)) {
          fs.copyFileSync(localSrc, this.popupScriptPath);
        } else {
          fs.writeFileSync(this.popupScriptPath, POPUP_SCRIPT_CONTENT, { encoding: "utf8" });
        }
      }
    } catch (e) {
      console.error("[CompanionEngine] Failed ensuring popup.ps1 on disk:", e);
    }
  }

  private loadReminders(): void {
    try {
      if (!fs.existsSync(this.remindersFilePath)) return;
      const raw = fs.readFileSync(this.remindersFilePath, "utf8");
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      const now = Date.now();
      for (const item of list) {
        if (!item || !item.id || typeof item.dueAt !== "number") continue;
        const remainingMs = item.dueAt - now;
        if (remainingMs > 1000) {
          // Re-arm remaining timer
          const timer = setTimeout(() => {
            this.triggerReminder(item.id);
          }, remainingMs);
          this.activeReminders.set(item.id, {
            id: item.id,
            title: item.title || "MEERA Reminder",
            message: item.message || "",
            minutes: item.minutes || 1,
            dueAt: item.dueAt,
            timer
          });
        }
      }
    } catch (e) {
      console.warn("[CompanionEngine] Failed to load reminders from disk:", e);
    }
  }

  private saveReminders(): void {
    try {
      const serializable = Array.from(this.activeReminders.values()).map(r => ({
        id: r.id,
        title: r.title,
        message: r.message,
        minutes: r.minutes,
        dueAt: r.dueAt
      }));
      fs.writeFileSync(this.remindersFilePath, JSON.stringify(serializable, null, 2), "utf8");
    } catch (e) {
      console.warn("[CompanionEngine] Failed to save reminders to disk:", e);
    }
  }

  private runPowerShell(script: string, timeoutMs: number = 5000): Promise<{ ok: boolean; stdout: string }> {
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

  private scheduleOsTask(reminderId: string, title: string, message: string, minutes: number): void {
    try {
      const now = new Date();
      const target = new Date(now.getTime() + Math.max(1, minutes) * 60 * 1000);
      const hours = String(target.getHours()).padStart(2, "0");
      const mins = String(target.getMinutes()).padStart(2, "0");
      const timeStr = `${hours}:${mins}`;

      const taskName = `MEERA_Reminder_${reminderId}`;
      const action = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\"${this.popupScriptPath}\\" -Title \\"⏰ ${title.replace(/"/g, "")}\\" -Message \\"${message.replace(/"/g, "")}\\" -DurationSec 8`;

      const child = spawn("schtasks", [
        "/create",
        "/tn", taskName,
        "/tr", action,
        "/sc", "once",
        "/st", timeStr,
        "/f"
      ], { windowsHide: true, stdio: "ignore" });
      child.unref();
    } catch {}
  }

  private deleteOsTask(reminderId: string): void {
    try {
      const taskName = `MEERA_Reminder_${reminderId}`;
      const child = spawn("schtasks", ["/delete", "/tn", taskName, "/f"], { windowsHide: true, stdio: "ignore" });
      child.unref();
    } catch {}
  }

  public sendToast(title: string = "MEERA", message: string, durationSec: number = 6): { ok: boolean; result: string } {
    this.ensurePopupScript();

    // 1. Launch visual purple on-screen desktop popup card (detached process)
    try {
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", this.popupScriptPath,
        "-Title", title,
        "-Message", message,
        "-DurationSec", String(durationSec)
      ], {
        windowsHide: true,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    } catch (e) {
      console.error("[CompanionEngine] Error spawning popup.ps1:", e);
    }

    // 2. Also register native Action Center toast in Windows Notification Center with registered AUMIDs
    const cleanT = (title || "MEERA").replace(/[<>&'"]/g, "");
    const cleanM = (message || "").replace(/[<>&'"]/g, "");
    const ps = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${cleanT}</text><text>${cleanM}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      $appIds = @('com.electron.meera-desktop', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
      foreach ($app in $appIds) {
        try {
          $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app)
          $notifier.Show($toast)
          break
        } catch {}
      }
    `;
    this.runPowerShell(ps, 3000).catch(() => {});

    return { ok: true, result: `Notification shown: "${message}"` };
  }

  private triggerReminder(id: string): void {
    const item = this.activeReminders.get(id);
    if (!item) return;

    this.activeReminders.delete(id);
    this.saveReminders();
    this.deleteOsTask(id);

    this.sendToast(`⏰ ${item.title}`, item.message, 8);
  }

  public setReminder(minutes: number, message: string, title: string = "MEERA Reminder"): { ok: boolean; reminder_id: string; minutes: number; result: string } {
    const mins = Math.max(0.1, Number(minutes || 1));
    const id = Math.random().toString(36).substring(2, 9);
    const ms = Math.round(mins * 60 * 1000);
    const dueAt = Date.now() + ms;

    const timer = setTimeout(() => {
      this.triggerReminder(id);
    }, ms);

    this.activeReminders.set(id, { id, message, title, minutes: mins, dueAt, timer });
    this.saveReminders();

    if (mins >= 1.0) {
      this.scheduleOsTask(id, title, message, mins);
    }

    return {
      ok: true,
      reminder_id: id,
      minutes: mins,
      result: `Scheduled reminder for ${mins} minute(s) from now: "${message}"`
    };
  }

  public listReminders(): { count: number; reminders: any[] } {
    const now = Date.now();
    const list = Array.from(this.activeReminders.values()).map(r => ({
      reminder_id: r.id,
      title: r.title,
      message: r.message,
      minutes_total: r.minutes,
      minutes_remaining: Math.max(0, Math.round(((r.dueAt - now) / 60000) * 10) / 10)
    }));
    return { count: list.length, reminders: list };
  }

  public cancelReminder(query: string): { ok: boolean; result?: string; error?: string } {
    const q = (query || "").toLowerCase().trim();
    for (const [id, r] of this.activeReminders.entries()) {
      if (id === q || r.message.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)) {
        if (r.timer) clearTimeout(r.timer);
        this.activeReminders.delete(id);
        this.saveReminders();
        this.deleteOsTask(id);
        return { ok: true, result: `Successfully cancelled reminder '${r.message}' (${id}).` };
      }
    }
    return { ok: false, error: `No active reminder found matching query '${query}'.` };
  }

  public async setBrightness(level: number): Promise<{ ok: boolean; brightness_percent: number; result: string; error?: string }> {
    const target = Math.max(0, Math.min(100, Math.round(level)));
    const ps = `
      $wmi = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
      if ($wmi) {
        Invoke-CimMethod -InputObject $wmi -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${target} } | Out-Null
        "OK"
      } else {
        "NOT_SUPPORTED"
      }
    `;
    const res = await this.runPowerShell(ps, 4000);
    if (res.stdout.trim() === "NOT_SUPPORTED") {
      return {
        ok: false,
        brightness_percent: target,
        result: "Hardware brightness control is not supported on this external monitor or desktop PC (WMI WmiMonitorBrightnessMethods is only available for built-in laptop displays).",
        error: "External monitor does not expose WMI brightness controls (DDC/CI or physical monitor buttons required)."
      };
    }
    return { ok: true, brightness_percent: target, result: `Display brightness set to ${target}%.` };
  }

  public async getBrightness(): Promise<{ brightness_percent: number; error?: string }> {
    const ps = `
      $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue
      if ($b) { $b.CurrentBrightness } else { "NOT_SUPPORTED" }
    `;
    const res = await this.runPowerShell(ps, 4000);
    const out = res.stdout.trim();
    if (out === "NOT_SUPPORTED") {
      return { brightness_percent: 100, error: "External monitor does not support WMI brightness." };
    }
    const val = parseInt(out, 10);
    return { brightness_percent: isNaN(val) ? 100 : val };
  }
}

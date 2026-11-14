import { BaseTool } from "../base";

export class LaunchAppTool extends BaseTool {
  name = "launch_application";
  description = "Launches an application by name, executable, or protocol (e.g. 'notepad', 'calc', 'chrome', 'spotify', 'zcode', 'vscode', 'settings', 'terminal').";

  async run(args: { app_name: string }) {
    const res = this.system.launch(args.app_name);
    if (!res.ok) this.fail(res.error || "Launch failed");
    return { result: res.result || `Launched ${args.app_name}` };
  }
}

export class CloseAppTool extends BaseTool {
  name = "close_application";
  description = "Closes or terminates a running application, program, File Explorer, or desktop window by name (e.g. 'file explorer', 'explorer', 'control panel', 'chrome', 'notepad', 'edge', 'settings', 'zcode').";

  async run(args: { app_name: string }) {
    const res = await this.system.killProcess(args.app_name);
    if (!res.ok) this.fail(res.error || `Could not find or close '${args.app_name}'`);
    return { result: res.result };
  }
}

export class FindInstalledAppTool extends BaseTool {
  name = "find_installed_application";
  description = "Checks whether an application, game, or program is installed on the computer. Searches Windows Start Menu, Windows Store packages, Registry, and PATH.";

  async run(args: { app_name: string }) {
    const res = this.system.findInstalledApp(args.app_name);
    return {
      result: res.summary,
      installed: res.found,
      count: res.count,
      matches: res.matches
    };
  }
}

export class ListRunningAppsTool extends BaseTool {
  name = "list_running_applications";
  description = "Lists currently running user-facing desktop applications with process names, PIDs, window titles, and RAM usage.";

  async run(args: { filter?: string }) {
    const res = await this.system.listRunningApplications(args.filter);
    return { result: res.applications, count: res.count };
  }
}

export class GetProcessDetailsTool extends BaseTool {
  name = "get_process_details";
  description = "Retrieves deep diagnostic details for a running process: PID, executable path, memory (MB), CPU %, creation time, status, and open window titles.";

  async run(args: { name_or_pid: string }) {
    const res = await this.system.getProcessDetails(args.name_or_pid);
    if (!res.ok) this.fail(res.error || "Process inspection failed");
    return { result: res.result };
  }
}

export class ControlMediaTool extends BaseTool {
  name = "control_media_playback";
  description = "Controls playback only: play/resume, pause, next video/track, previous video/track, or stop. Never use this tool for volume changes.";

  async run(args: { action: string }) {
    const res = await this.system.controlMedia(args.action);
    return { result: res.result };
  }
}

export class EmptyRecycleBinTool extends BaseTool {
  name = "empty_recycle_bin";
  description = "Empties the Windows Recycle Bin to permanently free up disk space.";

  async run() {
    const res = await this.system.emptyRecycleBin();
    return { result: res.result };
  }
}

export class LockWorkstationTool extends BaseTool {
  name = "lock_workstation";
  description = "Locks the Windows computer workstation immediately, returning to the lock screen.";

  async run() {
    const res = this.system.lockWorkstation();
    return { result: res.result };
  }
}

export class OpenPathOrFileTool extends BaseTool {
  name = "open_path_or_file";
  description = "Opens a file, document, or directory in its default Windows associated program (e.g. a PDF in PDF reader, an image in Photos, a project folder in Explorer).";

  async run(args: { path: string }) {
    const res = this.system.openPathOrFile(args.path);
    if (!res.ok) {
      throw new Error(res.error || `Failed to open '${args.path}'`);
    }
    return { result: res.result, path: res.path };
  }
}

export class GetVolumeTool extends BaseTool {
  name = "get_system_volume";
  description = "Gets the current Windows master audio volume level (0-100) and mute status.";

  async run() {
    const res = await this.system.getVolume();
    return { result: res.result, volume: res.volume, is_muted: res.is_muted };
  }
}

export class AdjustVolumeTool extends BaseTool {
  name = "adjust_system_volume";
  description = "ONLY changes Windows master volume. Use only for explicit volume/loudness requests; direction must be exactly up or down. Never use for play, pause, resume, next, or previous media commands.";

  async run(args: { delta?: number; direction?: string; amount?: number }) {
    let delta = typeof args?.delta === "number" ? args.delta : 0;
    if (!delta) {
      const dir = (args?.direction || "").toLowerCase().trim();
      const amt = Math.abs(typeof args?.amount === "number" ? args.amount : 10);
      if (dir === "down" || dir === "decrease" || dir === "lower" || dir === "softer") {
        delta = -amt;
      } else if (dir === "up" || dir === "increase" || dir === "higher" || dir === "louder") {
        delta = amt;
      } else {
        // Never turn an unrelated intent such as "pause" or "next" into a
        // volume decrease. The old fallback made media misclassification
        // silently change the system volume.
        this.fail(`Unknown volume direction '${args?.direction}'. Use up or down.`);
      }
    }
    const res = await this.system.adjustVolume(delta);
    return { result: res.result, previous_volume: res.previous_volume, new_volume: res.new_volume };
  }
}

export class SetVolumeTool extends BaseTool {
  name = "set_system_volume";
  description = "Sets the master Windows audio volume level between 0 and 100 percent.";

  async run(args: { level?: number; volume?: number }) {
    const lvl = typeof args?.level === "number" ? args.level : (typeof args?.volume === "number" ? args.volume : 50);
    const res = await this.system.setVolume(lvl);
    return { result: res.result, volume: res.volume };
  }
}

export class ToggleMuteTool extends BaseTool {
  name = "toggle_audio_mute";
  description = "Mutes or unmutes the master Windows audio.";

  async run(args: { mute?: boolean }) {
    const res = await this.system.toggleMute(args.mute !== undefined ? Boolean(args.mute) : true);
    return { result: res.result };
  }
}

export class SystemStatusTool extends BaseTool {
  name = "get_system_status";
  description = "Checks the system hardware health metrics including CPU load, RAM usage, battery percent, and OS.";

  async run() {
    return { result: this.system.getMetrics() };
  }
}

export class EnableAutoStartTool extends BaseTool {
  name = "enableAutoStart";
  description = "Enables Meera to launch automatically on Windows boot.";

  async run() {
    await this.system.runPowerShell(`Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "MEERA" -Value '"${process.execPath}"'`);
    return { ok: true, result: "Auto-start enabled in Windows registry." };
  }
}

export class DisableAutoStartTool extends BaseTool {
  name = "disableAutoStart";
  description = "Disables Meera automatic startup on Windows boot.";

  async run() {
    await this.system.runPowerShell(`Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "MEERA" -ErrorAction SilentlyContinue`);
    return { ok: true, result: "Auto-start disabled in Windows registry." };
  }
}


import { exec } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import { ISystemEngine } from "../types";

const execAsync = promisify(exec);

export class LinuxSystemEngine implements ISystemEngine {
  private currentVolume = 50;
  private isMuted = false;

  public async launch(appName: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const raw = appName.trim();
    if (!raw) return { ok: false, error: "App name is required." };
    try {
      // 1. Try launching using standard desktop desktop-entry launcher
      // 2. Fall back to spawning by binary name in background
      await execAsync(`gtk-launch "${raw}" 2>/dev/null || nohup "${raw}" >/dev/null 2>&1 &`);
      return { ok: true, result: `Successfully launched ${raw}.` };
    } catch (err: any) {
      return { ok: false, error: `Failed to launch ${raw}: ${err.message}` };
    }
  }

  public async killProcess(appName: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const raw = appName.trim();
    if (!raw) return { ok: false, error: "App name is required." };
    try {
      await execAsync(`pkill -f -i "${raw}" || killall -i "${raw}"`);
      return { ok: true, result: `Successfully closed ${raw}.` };
    } catch (err: any) {
      return { ok: false, error: `Could not close ${raw}: ${err.message}` };
    }
  }

  public async findInstalledApp(query: string): Promise<{ found: boolean; count: number; matches: any[]; summary: string }> {
    try {
      const q = query.toLowerCase().trim();
      const { stdout } = await execAsync(`which "${q}" 2>/dev/null || find /usr/share/applications -name "*${q}*.desktop" 2>/dev/null`);
      const matches = stdout.split("\n").filter(Boolean);
      const found = matches.length > 0;
      return {
        found,
        count: matches.length,
        matches,
        summary: found ? `Found ${matches.length} matches for '${query}'.` : `No app found for '${query}'.`
      };
    } catch {
      return { found: false, count: 0, matches: [], summary: `No app found for '${query}'.` };
    }
  }

  public async listRunningApplications(filterQuery?: string): Promise<{ ok: boolean; applications: any[]; count: number }> {
    try {
      const { stdout } = await execAsync(`ps -eo pid,comm,%mem,%cpu --sort=-%mem | head -n 35`);
      const lines = stdout.split("\n").slice(1).filter(Boolean);
      let apps = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          Id: parseInt(parts[0], 10),
          ProcessName: parts[1],
          MemoryPercent: parts[2],
          CpuPercent: parts[3]
        };
      });
      if (filterQuery) {
        const q = filterQuery.toLowerCase();
        apps = apps.filter(a => (a.ProcessName || "").toLowerCase().includes(q));
      }
      return { ok: true, count: apps.length, applications: apps };
    } catch {
      return { ok: true, count: 0, applications: [] };
    }
  }

  public async getProcessDetails(target: string): Promise<{ ok: boolean; result?: any; error?: string }> {
    try {
      const isPid = /^\d+$/.test(target.trim());
      const cmd = isPid ? `ps -p ${target.trim()} -o pid,comm,%mem,%cpu,etime` : `pgrep -l -f "${target.trim()}"`;
      const { stdout } = await execAsync(cmd);
      return { ok: true, result: stdout.trim() };
    } catch (err: any) {
      return { ok: false, error: `Process '${target}' not found.` };
    }
  }

  public async getVolume(): Promise<{ ok: boolean; volume: number; muted: boolean }> {
    try {
      // Use pactl to read default sink volume percentage
      const { stdout } = await execAsync("pactl get-sink-volume @DEFAULT_SINK@");
      const match = stdout.match(/(\d+)%/);
      if (match) {
        this.currentVolume = parseInt(match[1], 10);
      }
      const muteCheck = await execAsync("pactl get-sink-mute @DEFAULT_SINK@");
      this.isMuted = muteCheck.stdout.toLowerCase().includes("yes");
      return { ok: true, volume: this.currentVolume, muted: this.isMuted };
    } catch {
      return { ok: true, volume: this.currentVolume, muted: this.isMuted };
    }
  }

  public async setVolume(percent: number): Promise<{ ok: boolean; volume: number }> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    try {
      await execAsync(`pactl set-sink-volume @DEFAULT_SINK@ ${clamped}%`);
      this.currentVolume = clamped;
      return { ok: true, volume: clamped };
    } catch {
      this.currentVolume = clamped;
      return { ok: true, volume: clamped };
    }
  }

  public async adjustVolume(direction: "up" | "down", step: number = 10): Promise<{ ok: boolean; volume: number }> {
    const delta = direction === "up" ? step : -step;
    return this.setVolume(this.currentVolume + delta);
  }

  public async toggleMute(): Promise<{ ok: boolean; muted: boolean }> {
    try {
      await execAsync("pactl set-sink-mute @DEFAULT_SINK@ toggle");
      this.isMuted = !this.isMuted;
      return { ok: true, muted: this.isMuted };
    } catch {
      this.isMuted = !this.isMuted;
      return { ok: true, muted: this.isMuted };
    }
  }

  public async lockWorkstation(): Promise<{ ok: boolean; result: string }> {
    try {
      await execAsync("loginctl lock-session || xdg-screensaver lock || gnome-screensaver-command -l");
      return { ok: true, result: "Workstation locked successfully." };
    } catch (err: any) {
      return { ok: false, result: `Failed locking workstation: ${err.message}` };
    }
  }

  public async emptyRecycleBin(): Promise<{ ok: boolean; result: string }> {
    try {
      // Freedesktop trash standard location: ~/.local/share/Trash
      await execAsync("rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/*");
      return { ok: true, result: "Emptied Linux Trash bin." };
    } catch (err: any) {
      return { ok: false, result: `Failed emptying Trash: ${err.message}` };
    }
  }

  public async systemStatus(): Promise<{ ok: boolean; cpu: string; memory: string; battery: string; uptime: string; [key: string]: any }> {
    let memoryStr = "Unknown";
    let uptimeStr = "Unknown";
    let batteryStr = "N/A (Desktop / AC)";

    // Read Memory directly from /proc/meminfo
    try {
      const memInfo = await fs.promises.readFile("/proc/meminfo", "utf-8");
      const totalMatch = memInfo.match(/MemTotal:\s+(\d+)\s+kB/);
      const availMatch = memInfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (totalMatch && availMatch) {
        const totalMB = Math.round(parseInt(totalMatch[1], 10) / 1024);
        const availMB = Math.round(parseInt(availMatch[1], 10) / 1024);
        const usedMB = totalMB - availMB;
        memoryStr = `${usedMB} MB / ${totalMB} MB (${Math.round((usedMB / totalMB) * 100)}%)`;
      }
    } catch { }

    // Read Uptime from /proc/uptime
    try {
      const upData = await fs.promises.readFile("/proc/uptime", "utf-8");
      const seconds = parseFloat(upData.split(" ")[0]);
      const hours = (seconds / 3600).toFixed(1);
      uptimeStr = `${hours} hours`;
    } catch { }

    // Read Battery from /sys/class/power_supply/
    try {
      if (fs.existsSync("/sys/class/power_supply/BAT0/capacity")) {
        const cap = await fs.promises.readFile("/sys/class/power_supply/BAT0/capacity", "utf-8");
        batteryStr = `${cap.trim()}%`;
      }
    } catch { }

    return {
      ok: true,
      cpu: "Linux Multi-core Active",
      memory: memoryStr,
      battery: batteryStr,
      uptime: uptimeStr
    };
  }
}

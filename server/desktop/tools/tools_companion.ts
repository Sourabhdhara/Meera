import { BaseTool } from "../base";

export class GetCurrentTimeTool extends BaseTool {
  name = "get_current_time";
  description = "Returns the authoritative current local date and time from this computer. Use this whenever the user asks for the current time or date; do not guess. Default timezone is Asia/Kolkata (IST).";

  async run(args: any = {}) {
    let timezone = String(args?.timezone || "Asia/Kolkata");
    try { new Intl.DateTimeFormat("en-IN", { timeZone: timezone }).format(); }
    catch { timezone = "Asia/Kolkata"; }
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone, dateStyle: "full", timeStyle: "long", hour12: true
    }).format(now);
    return { result: formatted, timezone, iso_utc: now.toISOString(), epoch_ms: now.getTime() };
  }
}

export class ShowDesktopNotificationTool extends BaseTool {
  name = "show_desktop_notification";
  description = "Shows a custom purple desktop popup notification card in the bottom-right corner of the screen with a title, message, and alert chime, also sending a Windows Action Center toast.";

  async run(args: any) {
    const message = String(args?.message || args?.text || args?.content || args?.body || args?.prompt || "").trim();
    const title = String(args?.title || "MEERA").trim();
    const duration = Number(args?.duration || args?.duration_sec || 6);
    const res = this.companion.sendToast(title, message, duration);
    return { result: res.result };
  }
}

export class GetNetworkStatusTool extends BaseTool {
  name = "get_network_status";
  description = "Checks network connectivity, connected Wi-Fi network SSID, signal strength percentage, link speed, local IP address, and ping latency to the internet.";

  async run() {
    const res = await this.network.getStatus();
    return {
      result: res.summary,
      connected: res.status.connected,
      wifi: res.status.wifi,
      local_ip: res.status.local_ip,
      internet: res.status.internet
    };
  }
}

export class SetReminderTimerTool extends BaseTool {
  name = "set_reminder_timer";
  description = "Schedules a proactive timer or reminder that will alert the user after a given number of minutes with an on-screen purple notification popup card and an alert chime.";

  async run(args: any) {
    const minutes = Number(args?.minutes ?? args?.duration_minutes ?? args?.time_minutes ?? 1);
    const message = String(args?.message || args?.text || args?.reminder || "").trim();
    const title = String(args?.title || "MEERA Reminder").trim();
    const res = this.companion.setReminder(minutes, message, title);
    return { result: res.result, reminder_id: res.reminder_id, minutes: res.minutes };
  }
}

export class ListActiveRemindersTool extends BaseTool {
  name = "list_active_reminders";
  description = "Lists all currently pending reminders and timers with their remaining time and reminder IDs.";

  async run() {
    const res = this.companion.listReminders();
    return { result: res.reminders, count: res.count };
  }
}

export class CancelReminderTimerTool extends BaseTool {
  name = "cancel_reminder_timer";
  description = "Cancels an active reminder or timer by its reminder ID or partial reminder text.";

  async run(args: { reminder_query: string }) {
    const res = this.companion.cancelReminder(args.reminder_query);
    if (!res.ok) this.fail(res.error || "Reminder not found");
    return { result: res.result };
  }
}

export class SetDisplayBrightnessTool extends BaseTool {
  name = "set_display_brightness";
  description = "Sets the display screen brightness percentage between 10 and 100 percent. Works universally across external desktop monitors, laptops, and HDMI/DisplayPort screens.";

  async run(args: { level?: number; percent?: number }) {
    const target = args?.level ?? args?.percent ?? 100;
    const res = await this.companion.setBrightness(target);
    return { result: res.result, brightness_percent: res.brightness_percent };
  }
}

export class GetDisplayBrightnessTool extends BaseTool {
  name = "get_display_brightness";
  description = "Checks and returns the current estimated screen display brightness percentage.";

  async run() {
    const res = await this.companion.getBrightness();
    return { result: `Display brightness is at ${res.brightness_percent}%.`, brightness_percent: res.brightness_percent };
  }
}


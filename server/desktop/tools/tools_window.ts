import { BaseTool } from "../base";

export class ListWindowsTool extends BaseTool {
  name = "list_open_windows";
  description = "Lists all currently open, visible desktop application windows with their titles and process IDs.";

  async run() {
    const list = await this.window.listWindows();
    return { result: list, count: list.length };
  }
}

export class FocusWindowTool extends BaseTool {
  name = "focus_window";
  description = "Brings a specific application window to the foreground and focuses it.";

  async run(args: { title_query: string }) {
    const res = await this.window.focus(args.title_query);
    if (!res.ok) this.fail(res.error || "Focus failed");
    return { result: res.result };
  }
}

export class MinimizeWindowTool extends BaseTool {
  name = "minimize_window";
  description = "Minimizes a window by name or partial title.";

  async run(args: { title_query: string }) {
    const res = await this.window.minimize(args.title_query);
    if (!res.ok) this.fail(res.error || "Minimize failed");
    return { result: res.result };
  }
}

export class MaximizeWindowTool extends BaseTool {
  name = "maximize_window";
  description = "Maximizes a window by name or partial title.";

  async run(args: { title_query: string }) {
    const res = await this.window.maximize(args.title_query);
    if (!res.ok) this.fail(res.error || "Maximize failed");
    return { result: res.result };
  }
}

export class CloseWindowTool extends BaseTool {
  name = "close_window";
  description = "Sends a clean close signal to close a window gracefully (e.g. 'File Explorer', 'Notepad', 'Chrome', 'Settings', 'Downloads', 'Control Panel').";

  async run(args: { title_query: string }) {
    const res = await this.window.close(args.title_query);
    if (!res.ok) this.fail(res.error || "Close window failed");
    return { result: res.result };
  }
}

export class GetActiveWindowTool extends BaseTool {
  name = "get_active_window";
  description = "Returns the title and process ID of the window currently in the foreground.";

  async run() {
    const res = await this.window.getActive();
    return { result: { title: res.title, pid: res.pid } };
  }
}


import { BaseTool } from "./base";
import desktopSchemasRaw from "../desktop_schemas.json";

// Re-export foundational engines for maximum external reusability
export { SystemEngine } from "./core/system";
export { FileEngine } from "./core/files";
export { WindowEngine } from "./core/window";
export { InputEngine } from "./core/input";
export { ScreenEngine } from "./core/screen";
export { ScriptEngine } from "./core/script";
export { CompanionEngine } from "./core/companion";
export { NetworkEngine } from "./core/network";
export { UIAutomationEngine } from "./core/uia";
export { BaseTool } from "./base";

// Import all derived tools
import {
  LaunchAppTool,
  CloseAppTool,
  FindInstalledAppTool,
  ListRunningAppsTool,
  GetProcessDetailsTool,
  ControlMediaTool,
  EmptyRecycleBinTool,
  LockWorkstationTool,
  OpenPathOrFileTool,
  GetVolumeTool,
  AdjustVolumeTool,
  SetVolumeTool,
  ToggleMuteTool,
  SystemStatusTool,
  EnableAutoStartTool,
  DisableAutoStartTool
} from "./tools/tools_system";

import {
  ReadFileTool,
  WriteFileTool,
  AppendFileTool,
  ListFolderTool,
  SearchFilesTool,
  RecycleFileTool,
  WriteToNotepadTool
} from "./tools/tools_files";

import {
  ListWindowsTool,
  FocusWindowTool,
  MinimizeWindowTool,
  MaximizeWindowTool,
  CloseWindowTool,
  GetActiveWindowTool
} from "./tools/tools_window";

import {
  CopyClipboardTool,
  GetClipboardTool,
  PressHotkeyTool,
  TypeTextTool,
  PasteTextTool,
  MoveMouseTool,
  ClickMouseTool,
  ScrollMouseTool,
  GetMousePositionTool,
  ClickScreenElementTool,
  SelectDropdownItemTool,
  ScrollCalibratedTool,
  GetScreenElementsTool,
  GetUIElementsTool
} from "./tools/tools_input";

import {
  TakeScreenshotTool,
  GetScreenInfoTool,
  FindTextInImageTool
} from "./tools/tools_screen";

import {
  RunCommandTool,
  RunPowerShellScriptTool,
  RunPowerShellVisibleTool,
  SaveAutomationTool,
  RunAutomationTool,
  ListAutomationsTool,
  DeleteAutomationTool
} from "./tools/tools_runner";

import {
  ShowDesktopNotificationTool,
  GetCurrentTimeTool,
  GetNetworkStatusTool,
  SetReminderTimerTool,
  ListActiveRemindersTool,
  CancelReminderTimerTool,
  SetDisplayBrightnessTool,
  GetDisplayBrightnessTool
} from "./tools/tools_companion";

import {
  OpenUrlTool,
  SearchWebHeadlessTool,
  SearchGoogleTool,
  SearchYouTubeTool
} from "./tools/tools_web";

// Instantiate all derived tools
const toolsList: BaseTool[] = [
  new LaunchAppTool(),
  new CloseAppTool(),
  new FindInstalledAppTool(),
  new ListRunningAppsTool(),
  new GetProcessDetailsTool(),
  new ControlMediaTool(),
  new EmptyRecycleBinTool(),
  new LockWorkstationTool(),
  new OpenPathOrFileTool(),
  new GetVolumeTool(),
  new AdjustVolumeTool(),
  new SetVolumeTool(),
  new ToggleMuteTool(),
  new SystemStatusTool(),
  new EnableAutoStartTool(),
  new DisableAutoStartTool(),

  new ReadFileTool(),
  new WriteFileTool(),
  new AppendFileTool(),
  new ListFolderTool(),
  new SearchFilesTool(),
  new RecycleFileTool(),
  new WriteToNotepadTool(),

  new ListWindowsTool(),
  new FocusWindowTool(),
  new MinimizeWindowTool(),
  new MaximizeWindowTool(),
  new CloseWindowTool(),
  new GetActiveWindowTool(),

  new CopyClipboardTool(),
  new GetClipboardTool(),
  new PressHotkeyTool(),
  new TypeTextTool(),
  new PasteTextTool(),
  new MoveMouseTool(),
  new ClickMouseTool(),
  new ScrollMouseTool(),
  new GetMousePositionTool(),
  new ClickScreenElementTool(),
  new SelectDropdownItemTool(),
  new ScrollCalibratedTool(),
  new GetScreenElementsTool(),
  new GetUIElementsTool(),

  new TakeScreenshotTool(),
  new GetScreenInfoTool(),
  new FindTextInImageTool(),

  new RunCommandTool(),
  new RunPowerShellScriptTool(),
  new RunPowerShellVisibleTool(),
  new SaveAutomationTool(),
  new RunAutomationTool(),
  new ListAutomationsTool(),
  new DeleteAutomationTool(),

  new ShowDesktopNotificationTool(),
  new GetNetworkStatusTool(),
  new SetReminderTimerTool(),
  new ListActiveRemindersTool(),
  new CancelReminderTimerTool(),
  new SetDisplayBrightnessTool(),
  new GetDisplayBrightnessTool(),

  new OpenUrlTool(),
  new SearchWebHeadlessTool(),
  new SearchGoogleTool(),
  new SearchYouTubeTool(),
  new GetCurrentTimeTool()
];

const toolRegistry = new Map<string, BaseTool>();
for (const tool of toolsList) {
  toolRegistry.set(tool.name, tool);
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  healing_hints?: string[];
  healing_suggestion?: string;
  [key: string]: unknown;
}

function getHealingAdvice(name: string, args: Record<string, unknown>, errMsg: string): { hints: string[]; suggestion: string } {
  const hints: string[] = [];
  let suggestion = "";

  if (name === "launch_application") {
    hints.push("Call 'find_installed_application' with a broader query to locate the exact Start Menu AppID or executable.");
    hints.push("Use 'execute_powershell_script' with `Start-Process '<app_or_path>'` to launch directly via Windows Shell.");
    suggestion = `Try finding the exact installed name using find_installed_application(query="${args.app_name || ''}").`;
  } else if (name === "close_application" || name === "close_window") {
    hints.push("Call 'list_open_windows' to see exact visible window titles and process IDs.");
    hints.push("Call 'list_running_applications' to verify if the process is active in the background.");
    suggestion = "Call list_open_windows to inspect open window titles before closing.";
  } else if (name === "execute_powershell_script" || name === "execute_command") {
    hints.push("Check PowerShell command syntax, execution parameters, or permissions.");
    suggestion = "Check error output and adjust the PowerShell command syntax.";
  } else if (name === "open_path_or_file") {
    hints.push("Check if the path string contains environment variables or relative slashes.");
    hints.push("Meera's data directory is at %APPDATA%\\MEERA (expanded to 'C:\\Users\\<user>\\AppData\\Roaming\\MEERA').");
    hints.push("Use 'list_folder' or PowerShell Test-Path to verify the directory exists before opening.");
    suggestion = "Provide a valid absolute path or %APPDATA%\\MEERA without appending it to the project root.";
  } else if (name.startsWith("read_file") || name.startsWith("write_file") || name.startsWith("append_to_file")) {
    hints.push("Verify the absolute file path exists or use 'list_folder' to inspect directory contents.");
    hints.push("Ensure parent directories exist or use 'write_file'.");
    suggestion = "Check path formatting or list the folder with list_folder.";
  } else {
    hints.push("You can write a custom Tier 2 script (execute_powershell_script or execute_command) to inspect and solve this at the OS level.");
    suggestion = "Use dynamic PowerShell scripting to handle this custom edge case.";
  }

  return { hints, suggestion };
}

export function getDesktopToolSchemas(): any[] {
  return desktopSchemasRaw as any[];
}

export function isDesktopTool(name: string): boolean {
  return toolRegistry.has(name);
}

export async function executeDesktopTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    return {
      ok: false,
      error: `Unknown desktop tool '${name}'.`,
      healing_hints: ["Verify tool name in the registered desktop tool catalog."],
      healing_suggestion: "Check tool spelling against available tool declarations."
    };
  }
  try {
    const res = await tool.run(args || {});
    return { ok: true, ...res };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const { hints, suggestion } = getHealingAdvice(name, args, errMsg);
    return {
      ok: false,
      error: errMsg,
      healing_hints: hints,
      healing_suggestion: suggestion
    };
  }
}


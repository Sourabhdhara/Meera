// ---------------------------------------------------------------------------
// Common Cross-Platform Interfaces for MEERA Desktop Engines
// Guarantees 100% API parity between Windows and Linux implementations.
// ---------------------------------------------------------------------------

export interface ScriptResult {
  ok: boolean;
  result?: string;
  stdout?: string;
  stderr?: string;
  returncode?: number;
  error?: string;
}

export interface IScriptEngine {
  runCommand(cmd: string, timeoutSeconds?: number): Promise<ScriptResult>;
  runScript(script: string, timeoutSeconds?: number): Promise<ScriptResult>;
  runPowerShell?(script: string, timeoutSeconds?: number): Promise<ScriptResult>;
  saveAutomation(name: string, code: string, language?: string, description?: string): Promise<{ ok: boolean; result?: string; file?: string }>;
  runAutomation(name: string, timeoutSeconds?: number): Promise<ScriptResult>;
  listAutomations(): Promise<{ ok: boolean; automations: any[]; count: number }>;
  deleteAutomation(name: string): Promise<{ ok: boolean; result?: string }>;
}

export interface ISystemEngine {
  launch(appName: string): Promise<{ ok: boolean; result?: string; error?: string }> | { ok: boolean; result?: string; error?: string };
  killProcess(appName: string): Promise<{ ok: boolean; result?: string; error?: string }>;
  findInstalledApp(query: string): Promise<{ found: boolean; count: number; matches: any[]; summary: string }> | { found: boolean; count: number; matches: any[]; summary: string };
  listRunningApplications(filterQuery?: string): Promise<{ ok: boolean; applications: any[]; count: number }>;
  getProcessDetails(target: string): Promise<{ ok: boolean; result?: any; error?: string }>;
  getVolume(): Promise<{ ok: boolean; volume: number; is_muted?: boolean; muted?: boolean; result?: string }>;
  setVolume(percent: number): Promise<{ ok: boolean; volume: number }>;
  adjustVolume(direction: "up" | "down", step?: number): Promise<{ ok: boolean; volume: number }>;
  toggleMute(): Promise<{ ok: boolean; is_muted?: boolean; muted?: boolean }>;
  lockWorkstation(): Promise<{ ok: boolean; result: string }>;
  emptyRecycleBin(): Promise<{ ok: boolean; result: string }>;
  systemStatus(): Promise<{ ok: boolean; cpu: string; memory: string; battery: string; uptime: string; [key: string]: any }>;
}

export interface IWindowEngine {
  listWindows(): Promise<{ ok: boolean; windows: Array<{ pid: number; title: string; handle?: string | number }> }>;
  focusWindow(query: string): Promise<{ ok: boolean; result: string; title?: string }>;
  minimizeWindow(query: string): Promise<{ ok: boolean; result: string }>;
  maximizeWindow(query: string): Promise<{ ok: boolean; result: string }>;
  closeWindow(query: string): Promise<{ ok: boolean; result: string }>;
  getActiveWindow(): Promise<{ ok: boolean; title: string; pid: number }>;
}

export interface IInputEngine {
  clickMouse(button?: "left" | "right" | "middle", clicks?: number): Promise<{ ok: boolean; result: string }>;
  moveMouse(x: number, y: number): Promise<{ ok: boolean; result: string }>;
  typeText(text: string): Promise<{ ok: boolean; result: string }>;
  pressHotkey(hotkey: string): Promise<{ ok: boolean; result: string }>;
  getMousePosition(): Promise<{ ok: boolean; x: number; y: number }>;
}

export interface IScreenEngine {
  capture(filename?: string): Promise<{ ok: boolean; path: string; width: number; height: number; result: string; error?: string }>;
  getDimensions(): Promise<{ width: number; height: number }>;
  extractAllTextFromImage(imagePath: string): Promise<{ ok: boolean; text?: string; count?: number; error?: string }>;
  findTextInImage(imagePath: string, targetText: string): Promise<{ found: boolean; x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; matchedText?: string; strategy?: string; word?: string }>;
}

export interface IUIAEngine {
  getUIElements(filterType?: string): Promise<{ ok: boolean; elements: any[]; count: number; error?: string }>;
}

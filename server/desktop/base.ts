import os from "os";

// Windows Implementations
import { SystemEngine as WinSystemEngine } from "./core/system";
import { FileEngine } from "./core/files";
import { WindowEngine as WinWindowEngine } from "./core/window";
import { InputEngine as WinInputEngine } from "./core/input";
import { ScreenEngine as WinScreenEngine } from "./core/screen";
import { ScriptEngine as WinScriptEngine } from "./core/script";
import { CompanionEngine } from "./core/companion";
import { NetworkEngine } from "./core/network";
import { UIAutomationEngine as WinUIAutomationEngine } from "./core/uia";

// Linux Implementations
import { LinuxSystemEngine } from "./core/linux/system";
import { LinuxWindowEngine } from "./core/linux/window";
import { LinuxInputEngine } from "./core/linux/input";
import { LinuxScreenEngine } from "./core/linux/screen";
import { LinuxScriptEngine } from "./core/linux/script";
import { LinuxUIAEngine } from "./core/linux/uia";

// ---------------------------------------------------------------------------
// MEERA Desktop Control Agent — Cross-Platform BaseTool Factory
// Automatically instantiates native Linux or Windows engines based on runtime OS.
// ---------------------------------------------------------------------------

const isLinux = os.platform() === "linux";

const _system: any = isLinux ? new LinuxSystemEngine() : new WinSystemEngine();
const _files = new FileEngine(); // Shared 100% Cross-Platform
const _window: any = isLinux ? new LinuxWindowEngine() : new WinWindowEngine();
const _input: any = isLinux ? new LinuxInputEngine() : new WinInputEngine();
const _screen: any = isLinux ? new LinuxScreenEngine() : new WinScreenEngine();
const _script: any = isLinux ? new LinuxScriptEngine() : new WinScriptEngine();
const _companion = new CompanionEngine(); // Shared 100% Cross-Platform
const _network = new NetworkEngine(); // Shared 100% Cross-Platform
const _uia: any = isLinux ? new LinuxUIAEngine() : new WinUIAutomationEngine();

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;

  // Shared singletons accessible to all child tools via inheritance
  public static system = _system;
  public static files: FileEngine = _files;
  public static window = _window;
  public static input = _input;
  public static screen = _screen;
  public static script = _script;
  public static companion: CompanionEngine = _companion;
  public static network: NetworkEngine = _network;
  public static uia = _uia;

  public get system() { return BaseTool.system; }
  public get files(): FileEngine { return BaseTool.files; }
  public get window() { return BaseTool.window; }
  public get input() { return BaseTool.input; }
  public get screen() { return BaseTool.screen; }
  public get script() { return BaseTool.script; }
  public get companion(): CompanionEngine { return BaseTool.companion; }
  public get network(): NetworkEngine { return BaseTool.network; }
  public get uia() { return BaseTool.uia; }

  abstract run(args: Record<string, any>): Promise<any> | any;

  protected fail(message: string): never {
    throw new Error(message);
  }
}


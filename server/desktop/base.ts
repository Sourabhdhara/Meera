import { SystemEngine } from "./core/system";
import { FileEngine } from "./core/files";
import { WindowEngine } from "./core/window";
import { InputEngine } from "./core/input";
import { ScreenEngine } from "./core/screen";
import { ScriptEngine } from "./core/script";
import { CompanionEngine } from "./core/companion";
import { NetworkEngine } from "./core/network";
import { UIAutomationEngine } from "./core/uia";

// ---------------------------------------------------------------------------
// MEERA Desktop Control Agent — BaseTool Architecture
// All derived tools inherit from BaseTool to gain immediate access
// to the 9 foundational Direct Soul engines.
// ---------------------------------------------------------------------------

const _system = new SystemEngine();
const _files = new FileEngine();
const _window = new WindowEngine();
const _input = new InputEngine();
const _screen = new ScreenEngine();
const _script = new ScriptEngine();
const _companion = new CompanionEngine();
const _network = new NetworkEngine();
const _uia = new UIAutomationEngine();

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;

  // Shared singletons accessible to all child tools via inheritance
  public static system: SystemEngine = _system;
  public static files: FileEngine = _files;
  public static window: WindowEngine = _window;
  public static input: InputEngine = _input;
  public static screen: ScreenEngine = _screen;
  public static script: ScriptEngine = _script;
  public static companion: CompanionEngine = _companion;
  public static network: NetworkEngine = _network;
  public static uia: UIAutomationEngine = _uia;

  public get system(): SystemEngine { return BaseTool.system; }
  public get files(): FileEngine { return BaseTool.files; }
  public get window(): WindowEngine { return BaseTool.window; }
  public get input(): InputEngine { return BaseTool.input; }
  public get screen(): ScreenEngine { return BaseTool.screen; }
  public get script(): ScriptEngine { return BaseTool.script; }
  public get companion(): CompanionEngine { return BaseTool.companion; }
  public get network(): NetworkEngine { return BaseTool.network; }
  public get uia(): UIAutomationEngine { return BaseTool.uia; }

  abstract run(args: Record<string, any>): Promise<any> | any;

  protected fail(message: string): never {
    throw new Error(message);
  }
}


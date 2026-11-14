import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// UIAutomationEngine (Tier 4 Windows UI Automation Perception Core)
// Directly queries the active foreground window's accessibility tree using
// UIAutomationClient. Detects clickable buttons, edit boxes, dropdowns,
// checkboxes, tabs, menus, and hyperlinks with pixel-perfect coordinates.
// ---------------------------------------------------------------------------

export interface UIElement {
  id: number;
  name: string;
  type: string;
  auto_id?: string;
  class_name?: string;
  is_enabled: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cx: number;
  cy: number;
}

export interface ForegroundUIAData {
  ok: boolean;
  hwnd: number;
  title: string;
  class_name: string;
  elements: UIElement[];
  result?: string;
  error?: string;
}

export interface UIAMatchResult {
  found: boolean;
  element?: UIElement;
  cx?: number;
  cy?: number;
  strategy?: string;
}

function normalize(s?: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phoneticKey(s?: string): string {
  return normalize(s)
    .replace(/ou/g, "au")
    .replace(/bh/g, "v")
    .replace(/ee/g, "i")
    .replace(/ph/g, "f");
}

const UIA_FOREGROUND_PS = `
$ProgressPreference = 'SilentlyContinue';

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WinUiaCore {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static IntPtr DetectForegroundWindow(out string title, out string className, out uint pid) {
        SetProcessDPIAware();
        IntPtr result = IntPtr.Zero;
        string t = "";
        string c = "";
        uint p = 0;

        Thread th = new Thread(() => {
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero && IsWindowVisible(fg)) {
                var sb = new StringBuilder(256);
                GetWindowText(fg, sb, 256);
                if (sb.Length > 0) {
                    result = fg;
                    t = sb.ToString();
                    var csb = new StringBuilder(128);
                    GetClassName(fg, csb, 128);
                    c = csb.ToString();
                    GetWindowThreadProcessId(fg, out p);
                    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
                    return;
                }
            }

            if (hDesk != IntPtr.Zero) {
                EnumDesktopWindows(hDesk, (hWnd, lParam) => {
                    if (!IsWindowVisible(hWnd)) return true;
                    var sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    string winTitle = sb.ToString().Trim();
                    if (string.IsNullOrEmpty(winTitle)) return true;

                    var csb = new StringBuilder(128);
                    GetClassName(hWnd, csb, 128);
                    string winCls = csb.ToString();
                    if (winCls == "Progman" || winCls == "WorkerW" || winCls == "Shell_TrayWnd" || winCls == "Default IME" || winCls == "MSCTFIME UI") {
                        return true;
                    }

                    result = hWnd;
                    t = winTitle;
                    c = winCls;
                    GetWindowThreadProcessId(hWnd, out p);
                    return false;
                }, IntPtr.Zero);
                CloseDesktop(hDesk);
            }
        });

        th.SetApartmentState(ApartmentState.STA);
        th.Start();
        th.Join();

        title = t;
        className = c;
        pid = p;
        return result;
    }
}
"@ -ErrorAction SilentlyContinue

$title = ""
$cls = ""
[uint32]$pidVal = 0
$hwnd = [WinUiaCore]::DetectForegroundWindow([ref]$title, [ref]$cls, [ref]$pidVal)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output '{"hwnd":0,"title":"","elements":[]}'
    exit 0
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue

$root = $null
try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
} catch {
    Write-Output '{"hwnd":0,"title":"","elements":[]}'
    exit 0
}

if (-not $root) {
    Write-Output '{"hwnd":0,"title":"","elements":[]}'
    exit 0
}

if (-not $title) {
    try { $title = $root.Current.Name } catch {}
}

$cond = [System.Windows.Automation.Condition]::TrueCondition
$scope = [System.Windows.Automation.TreeScope]::Descendants

$rawElements = $null
try {
    $rawElements = $root.FindAll($scope, $cond)
} catch {
    $cleanT = ($title -replace '[\x00-\x1F\\"]', ' ').Trim()
    $hid = $hwnd.ToInt64()
    Write-Output ('{"hwnd":' + $hid + ',"title":"' + $cleanT + '","elements":[]}')
    exit 0
}

$interactiveTypes = @(
    "Button", "Edit", "ComboBox", "CheckBox", "RadioButton", 
    "MenuItem", "Menu", "Hyperlink", "TabItem", "ListItem", 
    "Document", "SplitButton", "ToolBar", "Slider", "TreeItem"
)

$outItems = @()
$idx = 1

foreach ($el in $rawElements) {
    try {
        $c = $el.Current
        if ($c.IsOffscreen) { continue }
        
        $w = [int]$c.BoundingRectangle.Width
        $h = [int]$c.BoundingRectangle.Height
        if ($w -le 0 -or $h -le 0) { continue }

        $type = $c.ControlType.ProgrammaticName -replace "ControlType.", ""
        $name = ($c.Name -replace '[\x00-\x1F]', ' ').Trim()
        $autoId = ($c.AutomationId -replace '[\x00-\x1F]', ' ').Trim()
        $clsName = ($c.ClassName -replace '[\x00-\x1F]', ' ').Trim()

        if ($name -or $autoId -or ($type -in $interactiveTypes)) {
            $x = [int]$c.BoundingRectangle.X
            $y = [int]$c.BoundingRectangle.Y
            $cx = [int]($x + ($w / 2.0))
            $cy = [int]($y + ($h / 2.0))

            $outItems += [PSCustomObject]@{
                id = $idx
                name = $name
                type = $type
                auto_id = $autoId
                class_name = $clsName
                is_enabled = [bool]$c.IsEnabled
                x = $x
                y = $y
                w = $w
                h = $h
                cx = $cx
                cy = $cy
            }
            $idx++
        }
    } catch {}
}

$cleanTitle = ($title -replace '[\x00-\x1F\\"]', ' ').Trim()
$payload = [PSCustomObject]@{
    hwnd = $hwnd.ToInt64()
    title = $cleanTitle
    class_name = $cls
    elements = $outItems
}

$payload | ConvertTo-Json -Compress -Depth 4
`;

export class UIAutomationEngine {
  public async getForegroundElements(): Promise<ForegroundUIAData> {
    return new Promise((resolve) => {
      const encoded = Buffer.from(UIA_FOREGROUND_PS.trim(), "utf16le").toString("base64");
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
      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, hwnd: 0, title: "", class_name: "", elements: [], error: "UI Automation timeout" });
      }, 5000);

      child.stdout.on("data", (d) => { stdout += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timeout);
        try {
          const sanitized = stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
          const parsed = JSON.parse(sanitized);
          const rawElements = Array.isArray(parsed.elements) ? parsed.elements : (parsed.elements ? [parsed.elements] : []);

          const elements: UIElement[] = rawElements.map((el: any, idx: number) => ({
            id: Number(el.id || idx + 1),
            name: String(el.name || ""),
            type: String(el.type || "Element"),
            auto_id: el.auto_id ? String(el.auto_id) : undefined,
            class_name: el.class_name ? String(el.class_name) : undefined,
            is_enabled: el.is_enabled !== false,
            bounds: {
              x: Math.round(Number(el.x || 0)),
              y: Math.round(Number(el.y || 0)),
              width: Math.round(Number(el.w || 0)),
              height: Math.round(Number(el.h || 0))
            },
            cx: Math.round(Number(el.cx || 0)),
            cy: Math.round(Number(el.cy || 0))
          }));

          resolve({
            ok: true,
            hwnd: Number(parsed.hwnd || 0),
            title: String(parsed.title || ""),
            class_name: String(parsed.class_name || ""),
            elements,
            result: `Discovered ${elements.length} interactive UI elements in foreground window '${parsed.title || "Window"}'.`
          });
        } catch (err: any) {
          resolve({
            ok: false,
            hwnd: 0,
            title: "",
            class_name: "",
            elements: [],
            error: `Failed to parse UI elements: ${err?.message || err}`
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, hwnd: 0, title: "", class_name: "", elements: [], error: err.message });
      });
    });
  }

  public resolveTarget(
    elements: UIElement[],
    target: string,
    ordinal?: string
  ): UIAMatchResult {
    const rawOrd = (ordinal || "").toLowerCase().trim();
    const rawTgt = (target || "").toLowerCase().trim();

    // 1. Ordinal handling
    if (rawOrd) {
      const ordMap: Record<string, number> = {
        "1st": 0, "first": 0, "1": 0,
        "2nd": 1, "second": 1, "2": 1,
        "3rd": 2, "third": 2, "3": 2,
        "4th": 3, "fourth": 3, "4": 3,
        "5th": 4, "fifth": 4, "5": 4
      };
      if (rawOrd === "last" && elements.length > 0) {
        const lastEl = elements[elements.length - 1];
        return { found: true, element: lastEl, cx: lastEl.cx, cy: lastEl.cy, strategy: "uia_ordinal_last" };
      }
      const idx = ordMap[rawOrd];
      if (idx !== undefined && elements[idx]) {
        return { found: true, element: elements[idx], cx: elements[idx].cx, cy: elements[idx].cy, strategy: "uia_ordinal" };
      }
    }

    if (!rawTgt) return { found: false };

    const normTgt = normalize(rawTgt);
    const phonTgt = phoneticKey(rawTgt);
    const tgtTokens = normTgt.split(" ").filter(w => w.length > 1);
    const phonTokens = tgtTokens.map(phoneticKey);

    // Identify requested control type hint (e.g. "search input", "save button", "view menu")
    let typeHint: string | undefined;
    if (rawTgt.includes("button") || rawTgt.includes("btn")) typeHint = "Button";
    else if (rawTgt.includes("input") || rawTgt.includes("text box") || rawTgt.includes("textbox") || rawTgt.includes("edit")) typeHint = "Edit";
    else if (rawTgt.includes("drop down") || rawTgt.includes("dropdown") || rawTgt.includes("combo")) typeHint = "ComboBox";
    else if (rawTgt.includes("check") || rawTgt.includes("checkbox")) typeHint = "CheckBox";
    else if (rawTgt.includes("radio")) typeHint = "RadioButton";
    else if (rawTgt.includes("menu")) typeHint = "MenuItem";
    else if (rawTgt.includes("tab")) typeHint = "TabItem";
    else if (rawTgt.includes("link")) typeHint = "Hyperlink";

    // Clean target of type hint words for cleaner name matching
    const cleanTgt = normTgt
      .replace(/\b(button|btn|input|text box|textbox|edit|dropdown|drop down|combobox|checkbox|check box|radio|menu|menuitem|tab|link)\b/g, "")
      .trim();
    const cleanPhon = phoneticKey(cleanTgt);

    // Strategy 1: Exact Name Match
    for (const el of elements) {
      const elNorm = normalize(el.name);
      if (elNorm === normTgt || (cleanTgt && elNorm === cleanTgt)) {
        if (!typeHint || el.type === typeHint || (typeHint === "Edit" && (el.type === "Edit" || el.type === "ComboBox" || el.type === "Document"))) {
          return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "uia_exact_name" };
        }
      }
    }

    // Strategy 2: Phonetic Name Match
    for (const el of elements) {
      const elPhon = phoneticKey(el.name);
      if (elPhon === phonTgt || (cleanPhon && elPhon === cleanPhon)) {
        return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "uia_phonetic_name" };
      }
    }

    // Strategy 3: Automation ID Match
    for (const el of elements) {
      if (el.auto_id) {
        const idNorm = normalize(el.auto_id);
        if (idNorm === normTgt || (cleanTgt && idNorm === cleanTgt) || idNorm.includes(cleanTgt || normTgt)) {
          return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "uia_automation_id" };
        }
      }
    }

    // Strategy 4: Multi-Token Match (all words in target exist in element name)
    if (tgtTokens.length > 0) {
      for (const el of elements) {
        const elPhon = phoneticKey(el.name);
        const allPresent = phonTokens.every(pt => pt.length > 2 && elPhon.includes(pt));
        if (allPresent) {
          return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "uia_multi_token" };
        }
      }
    }

    // Strategy 5: Substring Match
    const effectiveTarget = cleanTgt && cleanTgt.length >= 3 ? cleanTgt : normTgt;
    const effectivePhon = phoneticKey(effectiveTarget);

    if (effectiveTarget.length >= 2) {
      for (const el of elements) {
        const elNorm = normalize(el.name);
        const elPhon = phoneticKey(el.name);
        if (elNorm.includes(effectiveTarget) || elPhon.includes(effectivePhon)) {
          if (!typeHint || el.type === typeHint || (typeHint === "Edit" && (el.type === "Edit" || el.type === "ComboBox" || el.type === "Document"))) {
            return { found: true, element: el, cx: el.cx, cy: el.cy, strategy: "uia_substring" };
          }
        }
      }
    }

    // Strategy 6: ControlType alone (e.g. "click input box", "click message input", "click button")
    if (typeHint) {
      const matchingTypes = elements.filter(el => {
        if (typeHint === "Edit") return el.type === "Edit" || el.type === "ComboBox" || el.type === "Document";
        return el.type === typeHint;
      });
      if (matchingTypes.length === 1) {
        return { found: true, element: matchingTypes[0], cx: matchingTypes[0].cx, cy: matchingTypes[0].cy, strategy: "uia_sole_control_type" };
      }
      if (matchingTypes.length > 1) {
        if (cleanTgt) {
          const matched = matchingTypes.find(el => normalize(el.name).includes(cleanTgt));
          if (matched) {
            return { found: true, element: matched, cx: matched.cx, cy: matched.cy, strategy: "uia_type_and_substring" };
          }
        }
        return { found: true, element: matchingTypes[0], cx: matchingTypes[0].cx, cy: matchingTypes[0].cy, strategy: "uia_primary_control_type" };
      }
    }

    return { found: false };
  }
}

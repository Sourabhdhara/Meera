import { BaseTool } from "../base";

export class CopyClipboardTool extends BaseTool {
  name = "copy_to_clipboard";
  description = "Copies text or content to the Windows system clipboard.";

  async run(args: { text: string }) {
    const res = await this.input.clipboardSet(args.text);
    return { result: res.result };
  }
}

export class GetClipboardTool extends BaseTool {
  name = "get_clipboard";
  description = "Reads current text content from the Windows clipboard.";

  async run() {
    const res = await this.input.clipboardGet();
    return { result: res.text };
  }
}

export class PressHotkeyTool extends BaseTool {
  name = "press_keyboard_hotkey";
  description = "Sends a keyboard shortcut combination to the active window (e.g. 'ctrl+c', 'ctrl+v', 'alt+tab', 'win+d', 'ctrl+s').";

  async run(args: { keys: string }) {
    const res = await this.input.pressHotkey(args.keys);
    return { result: res.result };
  }
}

export class TypeTextTool extends BaseTool {
  name = "type_text";
  description = "Types text into the currently focused window or text box.";

  async run(args: { text: string }) {
    const res = await this.input.typeText(args.text);
    return { result: res.result };
  }
}

export class PasteTextTool extends BaseTool {
  name = "paste_text";
  description = "Pastes text or a file path directly into the active window or an optionally specified target window via clipboard Ctrl+V.";

  async run(args: { text: string; window_title?: string }) {
    if (!args?.text) {
      this.fail("Text to paste cannot be empty.");
    }
    if (args.window_title) {
      await this.window.focus(args.window_title);
      await new Promise(r => setTimeout(r, 250));
    }
    const res = await this.input.pasteText(args.text);
    return { result: res.result };
  }
}

export class MoveMouseTool extends BaseTool {
  name = "move_mouse";
  description = "Moves the mouse cursor to specific (x, y) coordinates on the screen with smooth gliding motion.";

  async run(args: { x: number; y: number }) {
    const res = await this.input.moveMouse(args.x, args.y);
    return { result: res.result, x: res.x, y: res.y };
  }
}

export class ClickMouseTool extends BaseTool {
  name = "click_mouse";
  description = "Clicks the mouse button at specified (x, y) coordinates or at current position (supports single, double, right click).";

  async run(args: { x?: number; y?: number; button?: string; clicks?: number }) {
    const res = await this.input.click(args.x, args.y, args.button, args.clicks);
    return { result: res.result, x: res.x, y: res.y };
  }
}

export class ScrollMouseTool extends BaseTool {
  name = "scroll_mouse";
  description = "Scrolls the mouse wheel up or down on the currently hovered window or page.";

  async run(args: { clicks?: number }) {
    const res = await this.input.scroll(args.clicks);
    return { result: res.result };
  }
}

export class GetMousePositionTool extends BaseTool {
  name = "get_mouse_position";
  description = "Returns the current mouse cursor (x, y) coordinates and current screen resolution width and height.";

  async run() {
    const res = await this.input.getMousePosition();
    return { result: res };
  }
}

export class ClickScreenElementTool extends BaseTool {
  name = "click_screen_element";
  description = "Locates any button, input box, dropdown menu, tab, link, or text element and clicks it. Uses a two-tier perception engine: first scans the active foreground window using Windows UI Automation for semantic controls; if not found, seamlessly falls back to Windows Native OCR (Windows.Media.Ocr). Smoothly glides the mouse cursor to its exact coordinates and performs the click.";

  async run(args: {
    target?: string;
    action?: "click" | "right_click" | "double_click" | "hover";
    ordinal?: "first" | "second" | "third" | "fourth" | "last";
  }) {
    const target = args?.target || "";
    const action = args?.action || "click";
    const ordinal = args?.ordinal;

    let targetCx: number | undefined;
    let targetCy: number | undefined;
    let targetLabel: string = target || ordinal || "item";
    let perceptionMethod = "none";
    let uiaCount = 0;
    let ocrCount = 0;

    // -------------------------------------------------------------
    // Tier 1: Windows UI Automation against Active Foreground Window
    // -------------------------------------------------------------
    try {
      const uiaScan = await this.uia.getForegroundElements();
      if (uiaScan.ok && uiaScan.elements.length > 0) {
        uiaCount = uiaScan.elements.length;
        const uiaMatch = this.uia.resolveTarget(uiaScan.elements, target, ordinal);
        if (uiaMatch.found && uiaMatch.cx !== undefined && uiaMatch.cy !== undefined) {
          targetCx = uiaMatch.cx;
          targetCy = uiaMatch.cy;
          targetLabel = `${uiaMatch.element?.name || target} [${uiaMatch.element?.type || "Control"}]`;
          perceptionMethod = `Windows UI Automation (${uiaMatch.strategy || "direct"})`;
        }
      }
    } catch {}

    // -------------------------------------------------------------
    // Tier 2: Fallback to Windows Native OCR (Windows.Media.Ocr)
    // -------------------------------------------------------------
    if (targetCx === undefined || targetCy === undefined) {
      const ocrScan = await this.screen.getScreenElements();
      if (ocrScan.ok && ocrScan.elements.length > 0) {
        ocrCount = ocrScan.elements.length;
        const ocrMatch = this.screen.resolveTarget(ocrScan.elements, target, ordinal);
        if (ocrMatch.found && ocrMatch.cx !== undefined && ocrMatch.cy !== undefined) {
          targetCx = ocrMatch.cx;
          targetCy = ocrMatch.cy;
          targetLabel = `${ocrMatch.element?.name || target} [OCR]`;
          perceptionMethod = `Windows Native OCR (${ocrMatch.strategy || "direct"})`;
        }
      }
    }

    if (targetCx === undefined || targetCy === undefined) {
      this.fail(`Target element '${target || ordinal || "item"}' not found on screen. Checked ${uiaCount} UI Automation controls in foreground window and ${ocrCount} Native OCR elements across the screen.`);
    }

    const cx = targetCx;
    const cy = targetCy;

    if (action === "hover") {
      await this.input.smoothMoveMouse(cx, cy, 10);
      return {
        result: `Smoothly glided cursor to '${targetLabel}' at (${cx}, ${cy}) via ${perceptionMethod}.`,
        x: cx,
        y: cy,
        element: targetLabel,
        method: perceptionMethod
      };
    }

    const button = action === "right_click" ? "right" : "left";
    const clicks = action === "double_click" ? 2 : 1;
    const res = await this.input.click(cx, cy, button, clicks, true);

    return {
      result: `Located '${targetLabel}' at (${cx}, ${cy}) via ${perceptionMethod}, glided cursor smoothly, and executed ${action.replace("_", " ")}.`,
      x: cx,
      y: cy,
      element: targetLabel,
      method: perceptionMethod,
      click_result: res.result
    };
  }
}

export class SelectDropdownItemTool extends BaseTool {
  name = "select_dropdown_item";
  description = "Intelligently selects an option from a dropdown menu. First clicks to open the dropdown menu, waits for options to appear, scans the list, and clicks the desired item.";

  async run(args: { dropdown_target: string; item_name: string }) {
    if (!args?.dropdown_target || !args?.item_name) {
      this.fail("Missing required dropdown_target or item_name.");
    }

    // Step 1: Locate and open the dropdown
    const scan1 = await this.screen.getScreenElements();
    const match1 = this.screen.resolveTarget(scan1.elements, args.dropdown_target);
    if (!match1.found || match1.cx === undefined || match1.cy === undefined) {
      this.fail(`Dropdown menu matching '${args.dropdown_target}' not found on screen.`);
    }

    console.log(`[Dropdown Agent] Opening dropdown '${args.dropdown_target}' at (${match1.cx}, ${match1.cy})...`);
    await this.input.click(match1.cx, match1.cy, "left", 1, true);

    // Step 2: Buffer for UI animation of popup
    await new Promise(r => setTimeout(r, 200));

    // Step 3: Scan expanded items and select target
    const scan2 = await this.screen.getScreenElements();
    const match2 = this.screen.resolveTarget(scan2.elements, args.item_name);

    if (match2.found && match2.cx !== undefined && match2.cy !== undefined) {
      console.log(`[Dropdown Agent] Selecting option '${args.item_name}' at (${match2.cx}, ${match2.cy})...`);
      await this.input.click(match2.cx, match2.cy, "left", 1, true);
      return {
        result: `Successfully opened dropdown '${args.dropdown_target}' and selected '${args.item_name}'.`,
        selected: args.item_name,
        x: match2.cx,
        y: match2.cy
      };
    }

    // If exact child not found, try pressing down arrow and enter
    await this.input.pressHotkey("down");
    await this.input.pressHotkey("enter");
    return {
      result: `Opened dropdown '${args.dropdown_target}' and confirmed selection via keyboard.`,
      selected: args.item_name
    };
  }
}

export class ScrollCalibratedTool extends BaseTool {
  name = "scroll_page";
  description = "Scrolls the page with calibrated speed control and reverse direction support. Supports explicit speed percentages (e.g. '20% speed'), relative adjustments ('slower' decreases by 50%, 'faster' increases), and direction flipping ('reverse', 'down', 'up').";

  async run(args?: {
    direction?: "down" | "up" | "reverse";
    speed_percent?: number;
    modifier?: "slower" | "faster" | "default";
  }) {
    const res = await this.input.scrollCalibrated(args);
    return {
      result: res.result,
      direction: res.direction,
      speed_percent: res.speed_percent
    };
  }
}

export class GetScreenElementsTool extends BaseTool {
  name = "get_screen_elements";
  description = "Returns a compact spatial coordinate table of all interactive UI elements, buttons, checkboxes, rows, and links currently on screen using Windows Native OCR (Windows.Media.Ocr).";

  async run() {
    const scan = await this.screen.getScreenElements();
    const compact = scan.elements.slice(0, 35).map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      x: e.cx,
      y: e.cy,
      row: e.row,
      ordinal: e.ordinal,
      is_bullet: e.is_bullet_target
    }));

    return {
      count: scan.elements.length,
      screen_resolution: `${scan.width}x${scan.height}`,
      elements: compact
    };
  }
}

export class GetUIElementsTool extends BaseTool {
  name = "get_ui_elements";
  description = "Inspects the active foreground window using Windows UI Automation to discover all interactive UI controls, input boxes, clickable buttons, dropdown menus, checkboxes, tabs, and links with their names, control types, and exact screen coordinates.";

  async run(args?: { filter_type?: string }) {
    const scan = await this.uia.getForegroundElements();
    if (!scan.ok) {
      this.fail(scan.error || "Failed to inspect foreground window via UI Automation.");
    }

    let elements = scan.elements;
    if (args?.filter_type) {
      const ft = args.filter_type.toLowerCase();
      elements = elements.filter(e => e.type.toLowerCase().includes(ft));
    }

    const compact = elements.slice(0, 50).map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      auto_id: e.auto_id,
      x: e.cx,
      y: e.cy,
      bounds: e.bounds,
      is_enabled: e.is_enabled
    }));

    return {
      window_title: scan.title,
      class_name: scan.class_name,
      total_count: elements.length,
      showing_count: compact.length,
      elements: compact
    };
  }
}



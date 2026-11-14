import { BaseTool } from "../base";

export class TakeScreenshotTool extends BaseTool {
  name = "take_screenshot";
  description = "Captures a full screenshot of the user's screen and saves it as a PNG file. By default saves directly to the user's Desktop for easy access.";

  async run(args: { filename?: string; save_to_desktop?: boolean }) {
    const res = await this.screen.capture(args?.filename);
    if (!res.ok) this.fail(res.error || "Screenshot capture failed");
    return { result: res.result, path: res.path, width: res.width, height: res.height };
  }
}

export class GetScreenInfoTool extends BaseTool {
  name = "get_screen_info";
  description = "Returns the physical screen resolution dimensions (width and height in pixels).";

  async run() {
    const dims = await this.screen.getDimensions();
    return { result: `${dims.width}x${dims.height}`, width: dims.width, height: dims.height };
  }
}

export class FindTextInImageTool extends BaseTool {
  name = "find_text_in_image";
  description = "Scans an image file (PNG/JPG binary) or desktop capture using Windows Native OCR (Windows.Media.Ocr) and returns the exact pixel coordinates (x, y, width, height, center_x, center_y) where the target text was found.";

  async run(args: { image_path: string; target_text: string }) {
    if (!args?.image_path || !args?.target_text) {
      this.fail("Both 'image_path' and 'target_text' are required.");
    }
    const res = await this.screen.findTextInImage(args.image_path, args.target_text);
    if (!res.found) {
      return { found: false, result: `Text '${args.target_text}' was not found in image '${args.image_path}'.` };
    }
    return {
      found: true,
      x: res.x,
      y: res.y,
      width: res.width,
      height: res.height,
      center_x: res.cx,
      center_y: res.cy,
      matched: res.matchedText,
      strategy: res.strategy,
      result: `Located '${args.target_text}' at pixel (${res.cx}, ${res.cy}) [${res.width}x${res.height}] in '${args.image_path}'.`
    };
  }
}



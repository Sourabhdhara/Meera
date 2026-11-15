import esbuild from "esbuild";
import fs from "fs";
import path from "path";

console.log("[Build] Building Node.js server from server/server.ts...");

const distDir = path.resolve("dist");
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

await esbuild.build({
  entryPoints: ["server/server.ts"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vite", "express", "ws", "@google/genai", "dotenv", "sql.js", "pdf-parse", "mammoth", "tesseract.js"],
  banner: {
    js: "process.env.NODE_ENV = process.env.NODE_ENV || 'production';",
  },
  sourcemap: true,
});

console.log("[Build] Successfully compiled dist/server.cjs!");

// Copy default directives data to dist/data
const dataDir = path.join(distDir, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const directivesSrc = path.resolve("server/data/default_directives.json");
if (fs.existsSync(directivesSrc)) {
  fs.copyFileSync(directivesSrc, path.join(dataDir, "default_directives.json"));
  console.log("[Build] Copied default_directives.json to dist/data/default_directives.json.");
}

// Copy native helper scripts (popup.ps1) to dist
const popupSrc = path.resolve("server/desktop/core/popup.ps1");
const popupDest = path.join(distDir, "popup.ps1");
if (fs.existsSync(popupSrc)) {
  fs.copyFileSync(popupSrc, popupDest);
  console.log("[Build] Copied popup.ps1 to dist/popup.ps1.");
}

console.log("[Build] Frontend assets are ready in dist/assets.");


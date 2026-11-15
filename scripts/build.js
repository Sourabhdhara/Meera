import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import cp from "child_process";
import electron from "electron";

console.log("[Build] Building Node.js server from server/server.ts...");

const distDir = path.resolve("dist");
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const isProduction = process.argv.includes("--production") || process.argv.includes("--bytecode");
const rawBundlePath = isProduction ? path.join(distDir, "server.raw.cjs") : path.join(distDir, "server.cjs");

await esbuild.build({
  entryPoints: ["server/server.ts"],
  outfile: rawBundlePath,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vite", "express", "ws", "@google/genai", "dotenv", "sql.js", "pdf-parse", "mammoth"],
  banner: {
    js: "process.env.NODE_ENV = process.env.NODE_ENV || 'production';",
  },
  sourcemap: !isProduction,
});

if (isProduction) {
  console.log("[Build] Compiling server bundle into protected V8 Bytecode (.jsc)...");
  const jscPath = path.join(distDir, "server.jsc");
  
  // Compile via Electron's exact V8 engine binary
  cp.execFileSync(electron, [
    "-e",
    `require("bytenode").compileFile({ filename: ${JSON.stringify(rawBundlePath)}, output: ${JSON.stringify(jscPath)}, compileAsModule: true })`
  ]);

  // Remove the readable raw bundle file
  if (fs.existsSync(rawBundlePath)) {
    fs.unlinkSync(rawBundlePath);
  }

  // Create ultra-resilient, clean bootstrap loader at dist/server.cjs
  const bootstrapLoader = `/* ===========================================================================
 * MEERA V2 — Protected V8 Bytecode Loader
 * ========================================================================= */
'use strict';
const path = require('path');
const fs = require('fs');
const bytenode = require('bytenode');

const bytecodePath = path.join(__dirname, 'server.jsc');

if (!fs.existsSync(bytecodePath)) {
  console.error('[MEERA Fatal] Protected bytecode bundle server.jsc not found at:', bytecodePath);
  process.exit(1);
}

try {
  // Execute protected V8 machine bytecode
  require(bytecodePath);
} catch (err) {
  console.error('[MEERA Fatal] Failed to load protected V8 bytecode bundle:', err);
  process.exit(1);
}
`;

  fs.writeFileSync(path.join(distDir, "server.cjs"), bootstrapLoader, "utf8");
  console.log("[Build] Successfully compiled and protected: dist/server.jsc (with bootstrap dist/server.cjs)!");
} else {
  console.log("[Build] Successfully compiled dist/server.cjs (Development mode)!");
}

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


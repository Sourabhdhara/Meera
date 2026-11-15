import fs from "fs";
import path from "path";
import cp from "child_process";

console.log("[Release Packager] Starting production release bundling...");

const rootDir = path.resolve(".");
const releaseDir = path.join(rootDir, "release-dist");

// 1. Clean and prepare release directory
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir, { recursive: true });

// 2. Build production bytecode
console.log("[Release Packager] Building V8 Bytecode via scripts/build.js --bytecode...");
cp.execFileSync("node", ["scripts/build.js", "--bytecode"], { stdio: "inherit" });

const coreStaging = path.join(releaseDir, "core");
fs.mkdirSync(coreStaging, { recursive: true });

// Helper to copy files recursively
function copyDirSync(src, dest, ignore = []) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, ignore);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 3. Stage necessary core files
console.log("[Release Packager] Staging core payload files...");
copyDirSync(path.join(rootDir, "dist"), path.join(coreStaging, "dist"), ["server.cjs.map"]);
copyDirSync(path.join(rootDir, "electron"), path.join(coreStaging, "electron"));
copyDirSync(path.join(rootDir, "renderer"), path.join(coreStaging, "renderer"));
copyDirSync(path.join(rootDir, "config"), path.join(coreStaging, "config"));

fs.copyFileSync(path.join(rootDir, "package.json"), path.join(coreStaging, "package.json"));
if (fs.existsSync(path.join(rootDir, "index.html"))) {
  fs.copyFileSync(path.join(rootDir, "index.html"), path.join(coreStaging, "index.html"));
}

// 4. Generate version & integrity metadata
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const versionMeta = {
  name: "MEERA",
  version: pkg.version || "1.0.0",
  releaseDate: new Date().toISOString(),
  target: "win32-x64",
  v8Version: "13.0.245.25-electron.0",
  entry: "electron/main.cjs"
};

fs.writeFileSync(path.join(coreStaging, "version.json"), JSON.stringify(versionMeta, null, 2), "utf8");
fs.writeFileSync(path.join(releaseDir, "version.json"), JSON.stringify(versionMeta, null, 2), "utf8");

// 5. Create core archive via PowerShell Compress-Archive
console.log("[Release Packager] Creating meera-core.zip payload...");
const zipDest = path.join(releaseDir, "meera-core.zip");
const psCommand = `Compress-Archive -Path '${coreStaging}\\*' -DestinationPath '${zipDest}' -Force`;
cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", psCommand], { stdio: "inherit" });

const stats = fs.statSync(zipDest);
console.log(`[Release Packager] Successfully generated payload: ${zipDest} (${(stats.size / 1024 / 1024).toFixed(2)} MB)!`);

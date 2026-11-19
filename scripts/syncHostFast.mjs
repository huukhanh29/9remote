#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "host");
const DIST_DIR = path.join(SERVER_DIR, "dist");

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const esbuildMain = path.join(globalRoot, "esbuild", "lib", "main.js");
    return await import(pathToFileURL(esbuildMain).href);
  }
}

const esbuild = await loadEsbuild();
const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
const globalPkg = path.join(globalRoot, "9remote");

// Ensure host/node_modules exists (symlink to global 9remote/node_modules if missing)
const hostNm = path.join(SERVER_DIR, "node_modules");
const globalNm = path.join(globalPkg, "node_modules");
if (!fs.existsSync(hostNm) && fs.existsSync(globalNm)) {
  fs.symlinkSync(globalNm, hostNm, "dir");
}

// Seed static assets from installed package if host/dist wasn't populated yet
if (!fs.existsSync(DIST_DIR) && fs.existsSync(path.join(globalPkg, "dist"))) {
  fs.cpSync(path.join(globalPkg, "dist"), DIST_DIR, { recursive: true });
}

const VERSION = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf-8")).version;
const PKG_NAME = process.env.NREMOTE_PKG || "9remote";

const baseConfig = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  sourcemap: false,
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: {
    "import.meta.url": "__importMetaUrl",
    "__CLI_VERSION__": JSON.stringify(VERSION),
    "__PKG_NAME__": JSON.stringify(PKG_NAME),
    "__DEFAULT_WORKER_URL__": JSON.stringify("https://9remote.cc"),
  },
};

await esbuild.build({
  ...baseConfig,
  entryPoints: [path.join(SERVER_DIR, "cli/index.js")],
  outfile: path.join(DIST_DIR, "cli.cjs"),
  external: ["node-pty", "sharp", "cloudflared", "@hurdlegroup/robotjs", "node-datachannel", "node-screenshots", "koffi", "systray", "fsevents", "@julusian/jpeg-turbo"],
});

await esbuild.build({
  ...baseConfig,
  entryPoints: [path.join(SERVER_DIR, "index.js")],
  outfile: path.join(DIST_DIR, "server.cjs"),
  external: ["node-pty", "sharp", "@hurdlegroup/robotjs", "node-datachannel", "node-screenshots", "koffi", "fsevents", "@julusian/jpeg-turbo"],
});

await esbuild.build({
  ...baseConfig,
  entryPoints: [path.join(SERVER_DIR, "features/terminal/ptyDaemon.js")],
  outfile: path.join(DIST_DIR, "ptyDaemon.cjs"),
  external: ["node-pty"],
});

await esbuild.build({
  ...baseConfig,
  entryPoints: [path.join(SERVER_DIR, "cli/scripts/install.js")],
  outfile: path.join(DIST_DIR, "install.cjs"),
  external: ["@hurdlegroup/robotjs"],
});

await import("./syncLocalAgent.mjs");

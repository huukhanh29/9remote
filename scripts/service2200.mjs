#!/usr/bin/env node

/**
 * Cross-platform installer & service manager for the custom 9remote instance on port 2200
 * Supports: Linux (systemd --user), macOS (LaunchAgents), Windows (Startup VBS + background process)
 *
 * Usage:
 *   node scripts/service2200.mjs setup    # One-command setup after git clone (installs, builds, enables autostart, starts)
 *   node scripts/service2200.mjs restart  # Rebuild fast & restart service
 *   node scripts/service2200.mjs stop     # Stop port 2200 service
 *   node scripts/service2200.mjs status   # Check health & info for port 2200 and 2208
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_DIST = path.join(ROOT, "host", "dist", "cli.cjs");
const HOME = os.homedir();
const PORT = Number(process.env.NREMOTE_PORT || 2200);
const NREMOTE_HOME = process.env.NREMOTE_HOME || path.join(HOME, `.9remote-${PORT}`);
const SALT = process.env.MACHINE_ID_SALT || `9remote-${PORT}`;
const NODE_BIN = process.execPath;

const action = process.argv[2] || "setup";

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function ensureGlobalDeps() {
  const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
  const has9remote = fs.existsSync(path.join(globalRoot, "9remote", "node_modules"));
  const hasEsbuild = fs.existsSync(path.join(globalRoot, "esbuild", "lib", "main.js"));

  if (!has9remote) {
    console.log("📦 Installing base 9remote global package...");
    run("npm install -g 9remote");
  }
  if (!hasEsbuild) {
    console.log("📦 Installing esbuild globally for fast bundling...");
    run("npm install -g esbuild");
    const esbuildInstall = path.join(globalRoot, "esbuild", "install.js");
    if (fs.existsSync(esbuildInstall)) {
      try { run(`"${NODE_BIN}" "${esbuildInstall}"`); } catch {}
    }
  }
}

function linkSharedItem(src, dest) {
  try {
    if (!fs.existsSync(src)) return;
    try {
      const st = fs.lstatSync(dest);
      if (st.isSymbolicLink() && fs.readlinkSync(dest) === src) return;
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest);
  } catch {}
}

function linkSharedWorkspacesAndDaemon() {
  const baseHome = path.join(HOME, ".9remote");
  if (!fs.existsSync(baseHome) || path.resolve(baseHome) === path.resolve(NREMOTE_HOME)) return;

  // Stop isolated ptyDaemon in NREMOTE_HOME if one was spawned before linking
  const oldPidFile = path.join(NREMOTE_HOME, "pids", "ptyDaemon.pid");
  try {
    if (fs.existsSync(oldPidFile) && !fs.lstatSync(oldPidFile).isSymbolicLink()) {
      const pid = parseInt(fs.readFileSync(oldPidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  } catch {}

  fs.mkdirSync(path.join(NREMOTE_HOME, "state"), { recursive: true });
  fs.mkdirSync(path.join(NREMOTE_HOME, "pids"), { recursive: true });
  fs.mkdirSync(path.join(NREMOTE_HOME, "config"), { recursive: true });

  // Disable second cloudflared quick-tunnel on port 2200 by default so it doesn't
  // trigger Cloudflare trycloudflare.com 429 rate-limit against the main 2208 tunnel.
  const settingsFile = path.join(NREMOTE_HOME, "config", "settings.json");
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ remoteEnabled: false }, null, 2), "utf-8");
  }

  // Share PTY daemon socket, daemon runtime, AI sessions, and workspace/session state files
  linkSharedItem(path.join(baseHome, "pty-daemon.sock"), path.join(NREMOTE_HOME, "pty-daemon.sock"));
  linkSharedItem(path.join(baseHome, "daemon"), path.join(NREMOTE_HOME, "daemon"));
  linkSharedItem(path.join(baseHome, "pids", "ptyDaemon.pid"), path.join(NREMOTE_HOME, "pids", "ptyDaemon.pid"));
  linkSharedItem(path.join(baseHome, "ai-sessions"), path.join(NREMOTE_HOME, "ai-sessions"));
  for (const name of ["sessions.json", "terminalWorkspaces.json", "conversationModes.json", "notes"]) {
    linkSharedItem(path.join(baseHome, "state", name), path.join(NREMOTE_HOME, "state", name));
  }
}

async function buildAndSync() {
  ensureGlobalDeps();
  fs.mkdirSync(path.join(NREMOTE_HOME, "bin"), { recursive: true });
  const defaultBin = path.join(HOME, ".9remote", "bin");
  if (fs.existsSync(defaultBin)) {
    try {
      fs.cpSync(defaultBin, path.join(NREMOTE_HOME, "bin"), { recursive: true, force: false });
    } catch {}
  }
  linkSharedWorkspacesAndDaemon();
  await import("./syncHostFast.mjs");
}

// ── Linux (systemd --user) ──────────────────────────────────────────────────

function linuxServicePath() {
  return path.join(HOME, ".config", "systemd", "user", `9remote-${PORT}.service`);
}

function setupLinux() {
  const svcPath = linuxServicePath();
  fs.mkdirSync(path.dirname(svcPath), { recursive: true });
  const unit = `[Unit]
Description=9remote Custom Local Service (Port ${PORT})
After=network.target

[Service]
Type=simple
Environment=NREMOTE_HOME=${NREMOTE_HOME}
Environment=NREMOTE_PORT=${PORT}
Environment=PORT=${PORT}
Environment=MACHINE_ID_SALT=${SALT}
ExecStart=${NODE_BIN} ${CLI_DIST} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(svcPath, unit, "utf-8");
  run("systemctl --user daemon-reload");
  run(`systemctl --user enable --now 9remote-${PORT}.service`);
  run(`systemctl --user restart 9remote-${PORT}.service`);
  try {
    execSync("systemctl --user is-active 9remote.service", { stdio: "ignore" });
    execSync("sleep 4");
    run("systemctl --user restart 9remote.service");
  } catch {}
  console.log(`✅ Linux systemd service enabled & started: 9remote-${PORT}.service`);
}

function stopLinux() {
  run(`systemctl --user stop 9remote-${PORT}.service`);
}

// ── macOS (LaunchAgents) ────────────────────────────────────────────────────

function macPlistPath() {
  return path.join(HOME, "Library", "LaunchAgents", `cc.9remote.local${PORT}.plist`);
}

function setupMac() {
  const plistPath = macPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.join(NREMOTE_HOME, "logs"), { recursive: true });
  const outLog = path.join(NREMOTE_HOME, "logs", "launchd.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cc.9remote.local${PORT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_DIST}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>NREMOTE_HOME</key>
    <string>${NREMOTE_HOME}</string>
    <key>NREMOTE_PORT</key>
    <string>${PORT}</string>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>MACHINE_ID_SALT</key>
    <string>${SALT}</string>
    <key>PATH</key>
    <string>${[path.dirname(NODE_BIN), process.env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"].filter(Boolean).join(":")}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${outLog}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, "utf-8");
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch {}
  run(`launchctl load -w "${plistPath}"`);
  // Respawn running 2208 server.cjs on macOS so it picks up the newly synced dist/server.cjs
  try {
    execSync("lsof -tiTCP:2208 -sTCP:LISTEN | xargs kill 2>/dev/null || true", { stdio: "ignore" });
  } catch {}
  console.log(`✅ macOS LaunchAgent loaded: ${plistPath}`);
}

function stopMac() {
  const plistPath = macPlistPath();
  if (fs.existsSync(plistPath)) {
    run(`launchctl unload "${plistPath}"`);
  }
}

// ── Windows (Startup VBS + hidden background process) ───────────────────────

function winStartupVbsPath() {
  const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `9remote-${PORT}.vbs`);
}

function winRunnerCmdPath() {
  return path.join(NREMOTE_HOME, `run-9remote-${PORT}.cmd`);
}

function stopWin() {
  try {
    execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${PORT}') do taskkill /F /PID %a`, { stdio: "ignore", windowsHide: true });
  } catch {}
}

function setupWin() {
  fs.mkdirSync(NREMOTE_HOME, { recursive: true });
  const cmdPath = winRunnerCmdPath();
  const vbsPath = winStartupVbsPath();
  fs.mkdirSync(path.dirname(vbsPath), { recursive: true });

  const cmdContent = `@echo off
set "NREMOTE_HOME=${NREMOTE_HOME}"
set "NREMOTE_PORT=${PORT}"
set "PORT=${PORT}"
set "MACHINE_ID_SALT=${SALT}"
"${NODE_BIN}" "${CLI_DIST}" start
`;
  fs.writeFileSync(cmdPath, cmdContent, "utf-8");

  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${cmdPath}""", 0, False
`;
  fs.writeFileSync(vbsPath, vbsContent, "utf-8");

  stopWin();
  const child = spawn("wscript.exe", [vbsPath], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  console.log(`✅ Windows Startup script created & launched: ${vbsPath}`);
}

// ── Status check ────────────────────────────────────────────────────────────

async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function printStatus() {
  const ok2200 = await checkHealth(PORT);
  const ok2208 = await checkHealth(2208);
  console.log(`\n=== 9Remote Local Status ===`);
  console.log(`- Port ${PORT} (Custom instance): ${ok2200 ? "🟢 RUNNING" : "🔴 STOPPED"} → http://localhost:${PORT}/workspace`);
  console.log(`  Data & Key file: ${path.join(NREMOTE_HOME, "keys.json")}`);
  console.log(`- Port 2208 (Default instance): ${ok2208 ? "🟢 RUNNING" : "🔴 STOPPED"} → http://localhost:2208/workspace`);
}

// ── Main ────────────────────────────────────────────────────────────────────

const platform = process.platform;

if (action === "setup" || action === "restart") {
  await buildAndSync();
  if (platform === "linux") setupLinux();
  else if (platform === "darwin") setupMac();
  else if (platform === "win32") setupWin();
  else throw new Error(`Unsupported platform: ${platform}`);
  await new Promise((r) => setTimeout(r, 2500));
  await printStatus();
} else if (action === "stop") {
  if (platform === "linux") stopLinux();
  else if (platform === "darwin") stopMac();
  else if (platform === "win32") stopWin();
  await printStatus();
} else if (action === "status") {
  await printStatus();
} else {
  console.log("Usage: node scripts/service2200.mjs [setup|restart|stop|status]");
  process.exit(1);
}

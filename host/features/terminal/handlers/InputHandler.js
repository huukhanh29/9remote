import * as daemonClient from "../ptyDaemonClient.js";
import { UPLOAD_DIR, saveSessionMetadata } from "../ptyHelper.js";
import { getConversation, getSessionAgent, setSessionAgent, setConversationId, setLastPrompt } from "../statusManager.js";
import { agentIdFromLaunchLine, parseResumeLine } from "../agentCatalog.js";
import { resumeCommand } from "../agentHistory.js";
import { engineFromAgent } from "../conversationModes.js";
import { RESIZE_MIN_COLS, RESIZE_MIN_ROWS, RESIZE_MAX_COLS, RESIZE_MAX_ROWS, RESIZE_SHRINK_SETTLE_MS } from "../constants.js";
import { setClipboardFromFile } from "../../../lib/clipboardSystem.js";
import fs from "fs";
import path from "path";

const PERSISTENCE_MODE = "daemon";
const PASTE_KEY = "\x16"; // Ctrl+V — tell the CLI to read the OS clipboard
const RESUME_EXIT_MS = 2000; // wait for claude to exit before relaunching the conversation
const CLEAR_LINE = process.platform === "win32" ? "\x1b" : "\x05\x15";

// Keystrokes arrive piecemeal, so rebuild the current line to spot agent launch
// lines (modal send is one chunk, hand typing is many). Capped so a running TUI
// can't grow the buffer forever; dropped once the line is evaluated on Enter.
const INPUT_LINE_CAP = 256;
const inputLines = new Map(); // sessionId -> partial line since last Enter

function evalLaunchLine(sessionId, line) {
  // A typed resume line carries the conversation id verbatim — recorded on the
  // spot, before any hook fires (and for CLIs whose hooks report no id at all).
  const resumed = parseResumeLine(line);
  if (resumed) {
    setConversationId(sessionId, resumed.agent, resumed.id, "resume");
    setSessionAgent(sessionId, resumed.agent);
    return;
  }
  const agentId = agentIdFromLaunchLine(line);
  if (agentId) return setSessionAgent(sessionId, agentId);
  // Not a launch line: with a TUI agent running this is the user's prompt, the
  // only prompt signal that exists without a hook. setLastPrompt drops it when
  // no agent is running and when the text isn't clean.
  setLastPrompt(sessionId, line);
}

function trackLaunchLine(sessionId, data) {
  if (typeof data !== "string" || !data) return;
  const line = (inputLines.get(sessionId) || "") + data;
  if (data.includes("\r") || data.includes("\n")) {
    for (const part of line.split(/\r\n|\r|\n/)) evalLaunchLine(sessionId, part);
    inputLines.delete(sessionId);
  } else {
    inputLines.set(sessionId, line.slice(-INPUT_LINE_CAP));
  }
}

// Debounce metadata writes on resize so rapid layout changes don't write the file
// on every event — but the last size always lands before the next agent restart.
let resizeSaveTimer = null;
const RESIZE_SAVE_DEBOUNCE_MS = 500;
function persistSessionsDebounced(sessions) {
  if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
  resizeSaveTimer = setTimeout(() => { resizeSaveTimer = null; saveSessionMetadata(sessions); }, RESIZE_SAVE_DEBOUNCE_MS);
}

const isSaneSize = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Pending shrink per session — a later resize (in either direction) supersedes it.
const shrinkTimers = new Map();
// Track each connected socket's reported terminal size per session: Map<sessionId, Map<socket, {cols, rows}>>
const socketSessionSizes = new Map();

export function recordSocketSessionSize(socket, sessionId, cols, rows) {
  if (!socket || !sessionId || !isSaneSize(cols, RESIZE_MIN_COLS, RESIZE_MAX_COLS) || !isSaneSize(rows, RESIZE_MIN_ROWS, RESIZE_MAX_ROWS)) return;
  let bySocket = socketSessionSizes.get(sessionId);
  if (!bySocket) {
    bySocket = new Map();
    socketSessionSizes.set(sessionId, bySocket);
  }
  bySocket.set(socket, { cols, rows });
  if (!socket.data?._termSizeCleanupArmed) {
    if (socket.data) socket.data._termSizeCleanupArmed = true;
    socket.on?.("disconnect", () => {
      for (const map of socketSessionSizes.values()) map.delete(socket);
    });
  }
}

function hasWiderConnectedPeer(sessionId, excludeSocket, targetCols) {
  const bySocket = socketSessionSizes.get(sessionId);
  if (!bySocket) return false;
  for (const [peer, size] of bySocket.entries()) {
    if (peer === excludeSocket) continue;
    if (peer?.connected === false) {
      bySocket.delete(peer);
      continue;
    }
    if (size.cols > targetCols) return true;
  }
  return false;
}

// Guard against duplicate multi-character batch/prompt inputs re-sent on carrier
// reconnect or ack timeout (along with their trailing Enter keystroke).
const BATCH_DEDUPE_WINDOW_MS = 5000;
const TRAILING_CR_DROP_MS = 500;
const MIN_BATCH_DEDUPE_LEN = 4;
const recentBatchInputs = new Map(); // sessionId -> { text, ts, dropCrUntil }

export function isDuplicateBatchInput(sessionId, rawData, now = Date.now()) {
  if (typeof rawData !== "string" || !rawData) return false;
  const prev = recentBatchInputs.get(sessionId);

  // Drop the trailing Enter that rides right behind a deduplicated batch text.
  if ((rawData === "\r" || rawData === "\n" || rawData === "\r\n") && prev) {
    if (prev.dropCrUntil && now <= prev.dropCrUntil) {
      prev.dropCrUntil = 0;
      return true;
    }
    return false;
  }

  // Single keystrokes or terminal escape/control sequences are never deduplicated,
  // and typing anything new clears the previous batch memory for this session.
  const trimmed = rawData.replace(/[\r\n]+$/, "");
  if (trimmed.length < MIN_BATCH_DEDUPE_LEN || rawData.startsWith("\x1b")) {
    recentBatchInputs.delete(sessionId);
    return false;
  }

  if (prev && prev.text === trimmed && (now - prev.ts) <= BATCH_DEDUPE_WINDOW_MS) {
    prev.ts = now;
    prev.dropCrUntil = rawData.endsWith("\r") || rawData.endsWith("\n") ? 0 : now + TRAILING_CR_DROP_MS;
    return true;
  }

  recentBatchInputs.set(sessionId, { text: trimmed, ts: now, dropCrUntil: 0 });
  return false;
}

function clearShrink(sessionId) {
  const t = shrinkTimers.get(sessionId);
  if (!t) return;
  clearTimeout(t);
  shrinkTimers.delete(sessionId);
}

// Apply a validated size to the PTY and remember it, so a respawn (daemon restart)
// inherits the real size instead of 80×24. Only reached for sizes that survived
// both the sanity floor and the shrink settle window.
function applyResize(sessions, sessionId, cols, rows, forceSigwinch = false) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const prevCols = session.lastCols ?? 0;
  const expanding = cols > prevCols || forceSigwinch;
  session.lastCols = cols;
  session.lastRows = rows;
  persistSessionsDebounced(sessions);
  if (session.daemon && daemonClient.isConnected()) {
    if (expanding && cols > 20) {
      // Nudge cols-1 then cols so kernel PTY always fires a fresh SIGWINCH to redraw TUI bars
      daemonClient.resizeSession(sessionId, cols - 1, rows);
      setTimeout(() => daemonClient.resizeSession(sessionId, cols, rows), 30);
      return;
    }
    return daemonClient.resizeSession(sessionId, cols, rows);
  }
  if (session.pty) {
    try { session.pty.resize(cols, rows); } catch (e) { console.log(`Resize failed for ${sessionId}: ${e.message}`); }
  }
}

export function setupInputHandlers(socket, sessions) {
  // cb is optional: per-keystroke passthrough never passes one; composed sends from the
  // mobile input box do, so a dead carrier can surface as "not sent" instead of a swallow.
  socket.on("input", ({ sessionId, data }, cb) => {
    if (!sessionId) return cb?.({ ok: false, error: "no-session-id" });
    const session = sessions.get(sessionId);
    if (!session) return cb?.({ ok: false, error: "no-session" });
    const strData = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
    if (isDuplicateBatchInput(sessionId, strData)) {
      console.log(`[input-dedupe] dropped duplicate batch input for ${sessionId} (len=${strData.length})`);
      return cb?.({ ok: true, deduped: true });
    }
    session.activeInputSocket = socket;
    const senderSize = socketSessionSizes.get(sessionId)?.get(socket);
    if (senderSize && (senderSize.cols !== session.lastCols || senderSize.rows !== session.lastRows)) {
      clearShrink(sessionId);
      applyResize(sessions, sessionId, senderSize.cols, senderSize.rows);
    }
    trackLaunchLine(sessionId, data);

    // Wrap multi-line text payloads in Bracketed Paste (\x1b[200~...\x1b[201~) so TUI agents
    // like `agy` treat internal newlines as a single multi-line message instead of submitting
    // the first line immediately and queueing subsequent lines as separate turns.
    let writePayload = strData;
    let delayedEnter = false;
    if (
      typeof strData === "string" &&
      strData.length > 1 &&
      !strData.startsWith("\x1b") &&
      /[\r\n]/.test(strData.replace(/[\r\n]+$/, ""))
    ) {
      delayedEnter = /[\r\n]$/.test(strData);
      const body = strData.replace(/[\r\n]+$/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      writePayload = `\x1b[200~${body}\x1b[201~`;
    }

    if (session.daemon && daemonClient.isConnected()) {
      // sendInput is fire-and-forget over the unix socket: a truthy return means the
      // write was accepted — the strongest landed-signal this path can give.
      const written = daemonClient.sendInput(sessionId, writePayload);
      if (written && delayedEnter) {
        setTimeout(() => daemonClient.sendInput(sessionId, "\r"), 40);
      }
      return cb?.(written ? { ok: true } : { ok: false, error: "daemon-write-failed" });
    }
    if (session.pty) {
      try {
        session.pty.write(writePayload);
        if (delayedEnter) {
          setTimeout(() => { try { session.pty.write("\r"); } catch {} }, 40);
        }
        cb?.({ ok: true });
      } catch (e) {
        return cb?.({ ok: false, error: e?.message || "write-failed" });
      }
    }
  });

  socket.on("resize", ({ sessionId, cols, rows }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Reject sizes no real layout produces — a pane measured mid-transition, or a
    // malformed payload. Emitting them would re-wrap scrollback narrow forever.
    if (!isSaneSize(cols, RESIZE_MIN_COLS, RESIZE_MAX_COLS)) return;
    if (!isSaneSize(rows, RESIZE_MIN_ROWS, RESIZE_MAX_ROWS)) return;

    recordSocketSessionSize(socket, sessionId, cols, rows);

    // Any newer size supersedes a shrink still waiting out its window.
    clearShrink(sessionId);
    if (cols >= (session.lastCols ?? 0)) return applyResize(sessions, sessionId, cols, rows);

    // Do not let a narrower background client (e.g. phone at 50 cols) shrink a session
    // while a wider desktop client is connected, unless this socket is actively typing.
    if (session.activeInputSocket !== socket && hasWiderConnectedPeer(sessionId, socket, cols)) {
      return;
    }

    // Narrower than current: hold it. A transient dip (panel slide, soft keyboard)
    // is followed by the real size before the window elapses, and that later call
    // clears this timer — so only a size the client actually settled on lands.
    shrinkTimers.set(sessionId, setTimeout(() => {
      shrinkTimers.delete(sessionId);
      if (session.activeInputSocket !== socket && hasWiderConnectedPeer(sessionId, socket, cols)) return;
      applyResize(sessions, sessionId, cols, rows);
    }, RESIZE_SHRINK_SETTLE_MS));
  });

  // Resume the exact conversation this session is running: a TUI agent hard-wraps
  // output at launch width, so after a layout change the only true fix is exit +
  // the CLI's own resume line, which re-renders the transcript at the current size.
  socket.on("session-resume", ({ sessionId }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const conv = getConversation(sessionId);
    // The engine, not the surface: a chat session records "claude-ui", and resumeCommand
    // only knows engine ids — it would answer null and the CLI would exit unrecovered.
    const line = conv && resumeCommand(engineFromAgent(conv.agent), conv.id, true);
    if (!line) return;
    const send = (data) => {
      if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
      if (session.pty) session.pty.write(data);
    };
    send("\x03\x03"); // Ctrl+C x2 — exit the running TUI
    // Clear any leaked terminal responses or dirty chars on the prompt before typing resume line
    setTimeout(() => send(`${CLEAR_LINE}${line}\r`), RESUME_EXIT_MS);
  });

  socket.on("upload-file", ({ sessionId, filename, size, content }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    try {
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFilename}`);
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
      console.log(`📎 File uploaded: ${filePath} (${size} bytes)`);
      if (session.daemon && daemonClient.isConnected()) daemonClient.sendInput(sessionId, filePath);
      else if (session.pty) session.pty.write(filePath);
    } catch (error) {
      console.error("File upload error:", error);
      socket.emit("output", { sessionId, enc: "bin", data: Buffer.from(`\r\nError uploading file: ${error.message}\r\n`, "utf-8") });
    }
  });

  // Attach a pasted image/file into the CLI, mirroring a real host paste:
  //  - image → OS clipboard + Ctrl+V (CLI reads image bytes → [Image #N])
  //  - file  → write to disk + type its path (CLI reads the file reference/path)
  // Ack lets web send attachments serially so the CLI consumes each before the next.
  socket.on("clipboard-attach", async ({ sessionId, filename, type, content }, ack) => {
    if (!sessionId) return ack?.({ success: false, error: "no session" });
    const session = sessions.get(sessionId);
    if (!session) return ack?.({ success: false, error: "no session" });
    try {
      const safeFilename = (filename || "paste").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFilename}`);
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
      const isImage = typeof type === "string" && type.startsWith("image/");
      // Detect whether this terminal is running `agy` (Antigravity CLI): unlike Claude Code,
      // `agy` does not read X11/OS image clipboard on Ctrl+V (\x16); it expects the image file path.
      let activeAgent = session.agent || getSessionAgent(sessionId) || getConversation(sessionId)?.agent || null;
      if (!activeAgent && session.daemon && daemonClient.isConnected()) {
        const live = await daemonClient.listSessions().catch(() => []);
        const fg = (live.find((s) => s.id === sessionId)?.foregroundProcess || "").toLowerCase();
        if (fg === "agy" || fg.includes("antigravity")) activeAgent = "antigravity";
      }
      const isAgy = activeAgent === "antigravity" || activeAgent === "agy";
      let data;
      if (isImage && !isAgy) {
        try {
          await setClipboardFromFile(filePath, type);
          data = PASTE_KEY;
        } catch {
          data = `${filePath} `;
        }
      } else {
        // Trailing space separates the path from any following text/next path.
        data = `${filePath} `;
      }
      if (session.daemon && daemonClient.isConnected()) daemonClient.sendInput(sessionId, data);
      else if (session.pty) session.pty.write(data);
      ack?.({ success: true });
    } catch (error) {
      console.error("Clipboard attach error:", error);
      ack?.({ success: false, error: error.message });
    }
  });
}

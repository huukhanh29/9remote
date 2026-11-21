// Antigravity CLI (`agy`) quota fetcher: runs `agy -p /usage` (0 AI tokens)
// and reads the active model from ~/.gemini/antigravity-cli/settings.json so the
// primary bar (5h / weekly) reflects the model currently in use, while the
// popover buckets list all remaining model groups.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "../constants.js";
import { clampPercent, makeResult, parseResetTimestamp, readJsonFile } from "../lib/quotaWindow.js";

const execFileAsync = promisify(execFile);
const AGY_USAGE_TIMEOUT_MS = 15_000;

function resolveAgyBin() {
  const candidates = [
    process.env.AGY_BIN,
    join(homedir(), ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy"
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "agy";
}

function parseAgyReset(raw) {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // "2026-11-28 20:34 +07" -> "2026-11-28T20:34:00+07:00"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?\s*([+-]\d{2})(?::?(\d{2}))?$/);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3] || "00"}${m[4]}:${m[5] || "00"}`;
    const ts = Date.parse(iso);
    if (!Number.isNaN(ts)) return ts;
  }
  return parseResetTimestamp(s);
}

function shortGroupName(group) {
  const g = group.toLowerCase();
  if (g.includes("argon")) return "Argon";
  if (g.includes("claude") || g.includes("gpt")) return "Claude/GPT";
  if (g.includes("gemini")) return "Gemini";
  return group.slice(0, 12);
}

export function parseAgyUsageOutput(stdout, activeModel = "") {
  const rows = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^quota:?$/i.test(line)) continue;
    const cols = line.split(/\s{2,}/);
    if (cols.length < 3) continue;
    const [group, label, value, resetStr] = cols;
    const pctMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
    if (!pctMatch) continue; // skip "disabled" or non-percent rows
    const remainingPct = Number(pctMatch[1]);
    if (!Number.isFinite(remainingPct)) continue;
    const isFiveHour = /five\s*hour|5\s*h/i.test(label);
    const isWeekly = /week/i.test(label);
    rows.push({
      group,
      label,
      kind: isFiveHour ? "5h" : isWeekly ? "wk" : "other",
      usedPercent: clampPercent(100 - remainingPct),
      windowMinutes: isFiveHour ? SESSION_WINDOW_MINUTES : WEEKLY_WINDOW_MINUTES,
      resetsAt: parseAgyReset(resetStr)
    });
  }
  if (!rows.length) return null;

  const modelLower = String(activeModel || "").toLowerCase();
  const findRow = (groupRe, kind) =>
    rows.find((r) => groupRe.test(r.group) && r.kind === kind) || null;

  let primarySession = null;
  let primaryWeekly = null;

  if (modelLower.includes("claude") || modelLower.includes("gpt")) {
    primarySession = findRow(/claude|gpt/i, "5h");
    primaryWeekly = findRow(/claude|gpt/i, "wk");
  } else if (modelLower.includes("argon")) {
    primaryWeekly = findRow(/argon/i, "wk");
    primarySession = findRow(/argon/i, "5h") || findRow(/^gemini\s+models$/i, "5h");
  } else {
    primarySession = findRow(/^gemini\s+models$/i, "5h") || findRow(/gemini/i, "5h");
    primaryWeekly = findRow(/^gemini\s+models$/i, "wk") || findRow(/gemini/i, "wk");
  }

  // Fallback if active model's 5h window is disabled (e.g. Claude/GPT 5h disabled)
  const session = primarySession || primaryWeekly || rows[0];
  const weekly = primaryWeekly && primaryWeekly !== session ? primaryWeekly : null;

  // Include all other model quota rows as popover buckets so user can inspect every pool
  const usedRefs = new Set([session, weekly].filter(Boolean));
  const buckets = rows
    .filter((r) => !usedRefs.has(r))
    .map((r) => ({
      name: `${shortGroupName(r.group)} ${r.kind === "5h" ? "5h" : "wk"}`,
      usedPercent: r.usedPercent,
      windowMinutes: r.windowMinutes,
      resetsAt: r.resetsAt
    }));

  return { session, weekly, buckets: buckets.length ? buckets : null };
}

export async function fetchAntigravityQuota() {
  const agyBin = resolveAgyBin();
  const settingsPath = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  const settings = await readJsonFile(settingsPath);
  const activeModel = settings?.model || "";

  try {
    const { stdout } = await execFileAsync(agyBin, ["-p", "/usage"], {
      timeout: AGY_USAGE_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: "1" }
    });
    const parsed = parseAgyUsageOutput(stdout, activeModel);
    if (!parsed) {
      return makeResult("antigravity", "unavailable", "No quota data from agy -p /usage");
    }
    return makeResult("antigravity", "ok", null, parsed);
  } catch (e) {
    if (e?.code === "ENOENT") {
      return makeResult("antigravity", "unavailable", "Antigravity CLI not installed");
    }
    return makeResult("antigravity", "error", e?.message || "agy usage failed");
  }
}

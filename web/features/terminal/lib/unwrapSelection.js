// Smart unwrap for text copied from narrow terminal panes (e.g. Claude Code / Codex / agy TUI),
// where hard-wrapped CRLF + indentation split long file paths, URLs, commands, and prose across lines.

const LIST_OR_PROMPT_START_RE = /^([-*•❯>$#]\s+|\d+[.)]\s+|[┌┬┐├┼┤└┴┘╭╮╰╯═─]{2,}|>>>\s+)/;
const PATH_OR_URL_TOKEN_RE = /^(https?:\/\/[^\s]+|~\/[^\s]*|\/[^\s]+|\.\.?\/[^\s]*|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]*)$/;
const PATH_CONT_TOKEN_RE = /^[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

function stripBoxBorders(line) {
  return line
    .replace(/[ \t]+$/, "")
    .replace(/^[ \t]*[│┃┆┊][ \t]?/, "")
    .replace(/[ \t]?[│┃┆┊][ \t]*$/, "");
}

export function unwrapTerminalSelection(rawText) {
  if (typeof rawText !== "string" || !rawText.includes("\n")) return rawText;

  const lines = rawText.replace(/\r\n/g, "\n").split("\n").map(stripBoxBorders);
  if (lines.length <= 1) return rawText;

  const out = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = out[out.length - 1];
    const currRaw = lines[i];
    const currTrim = currRaw.trimStart();
    const prevTrim = prev.trimStart();

    // Preserve empty lines (paragraph breaks)
    if (!prevTrim || !currTrim) {
      out.push(currRaw);
      continue;
    }

    // Preserve explicit list items, shell prompts, or horizontal dividers
    if (LIST_OR_PROMPT_START_RE.test(currTrim)) {
      out.push(currRaw);
      continue;
    }

    // Shell line continuation (`\`) at end of previous line -> join with single space
    if (prev.endsWith(" \\")) {
      out[out.length - 1] = `${prev.slice(0, -1)}${currTrim}`;
      continue;
    }

    // Case 1: Broken file path or URL wrapped mid-token across pane width -> join without space
    const prevTokens = prevTrim.split(/\s+/);
    const lastToken = prevTokens[prevTokens.length - 1] || "";
    const firstToken = currTrim.split(/\s+/)[0] || "";
    const isNewUrlOrHome = /^(https?:\/\/|\/home\/|\/Users\/|~\/)/.test(firstToken);

    if (
      PATH_OR_URL_TOKEN_RE.test(lastToken) &&
      PATH_CONT_TOKEN_RE.test(firstToken) &&
      !isNewUrlOrHome &&
      !firstToken.startsWith("-") &&
      (lastToken.endsWith("/") || lastToken.endsWith("-") || lastToken.endsWith("_") || !currTrim.includes(" "))
    ) {
      out[out.length - 1] = `${prev}${currTrim}`;
      continue;
    }

    // Case 2: All other wrapped lines inside a terminal selection -> join into a single line with space
    out[out.length - 1] = `${prev} ${currTrim}`;
  }

  return out.join("\n").trim();
}

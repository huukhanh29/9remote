// Smart unwrap for text copied from narrow terminal panes (e.g. Claude Code / Codex / agy TUI),
// where hard-wrapped CRLF + indentation split long file paths, URLs, commands, and prose across lines.

const LIST_OR_PROMPT_START_RE = /^([-*•❯>$#]\s+|\d+[.)]\s+|[┌┬┐├┼┤└┴┘╭╮╰╯│═─]+|\|\s+|>>>\s+|\.\.\.\s+)/;
const CODE_OR_LOG_START_RE = /^(\d{4}-\d{2}-\d{2}[T\s]|\[(INFO|WARN|ERROR|DEBUG)\]|(import|export|const|let|var|function|class|return|if|for|while|switch|case|def|async|await)\b)/;
const PATH_OR_URL_TOKEN_RE = /^(https?:\/\/[^\s]+|~\/[^\s]*|\/[^\s]+|\.\.?\/[^\s]*|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]*)$/;
const PATH_CONT_TOKEN_RE = /^[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const LOWER_START_RE = /^[a-zàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/;
// CLI flags, quoted args, pipes/logical operators, or path args continuing a wrapped command line
const CMD_ARG_CONT_RE = /^(--[a-zA-Z0-9][\w-]*|-[a-zA-Z0-9]+\b|&&|\|\||~\/|\.\.?\/|\/[a-zA-Z0-9._-]+|["'`])/;

export function unwrapTerminalSelection(rawText) {
  if (typeof rawText !== "string" || !rawText.includes("\n")) return rawText;

  const lines = rawText.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
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

    // Preserve explicit list items, prompts, box drawings, and log/code statement starts
    if (LIST_OR_PROMPT_START_RE.test(currTrim) || CODE_OR_LOG_START_RE.test(currTrim)) {
      out.push(currRaw);
      continue;
    }

    // Shell line continuation (`\`) at end of previous line -> join with single space
    if (prev.endsWith(" \\")) {
      out[out.length - 1] = `${prev.slice(0, -1)}${currTrim}`;
      continue;
    }

    // Case 1: Broken file path or URL wrapped mid-token across pane width
    const prevTokens = prevTrim.split(/\s+/);
    const lastToken = prevTokens[prevTokens.length - 1] || "";
    const firstToken = currTrim.split(/\s+/)[0] || "";
    const isNewUrlOrHome = /^(https?:\/\/|\/home\/|\/Users\/|~\/)/.test(firstToken);

    if (
      PATH_OR_URL_TOKEN_RE.test(lastToken) &&
      PATH_CONT_TOKEN_RE.test(firstToken) &&
      !isNewUrlOrHome &&
      (lastToken.endsWith("/") || lastToken.endsWith("-") || lastToken.endsWith("_") || /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]*)*$/.test(firstToken)) &&
      currTrim.split(/\s+/).length === 1
    ) {
      out[out.length - 1] = `${prev}${currTrim}`;
      continue;
    }

    // Case 2: TUI wrapped prose or command line (indented continuation or lowercase continuation)
    const prevIndent = prev.length - prevTrim.length;
    const currIndent = currRaw.length - currTrim.length;
    const prevHasTuiBullet = /^[●•⎿✦◆▪▸-]\s+/.test(prevTrim);
    const prevEndsTerminalPunct = /[.!?;:]$/.test(prevTrim);

    const isTuiIndentedWrap = (currIndent >= 2 && (currIndent === prevIndent || prevHasTuiBullet));
    const isLowerContinuation = !prevEndsTerminalPunct && LOWER_START_RE.test(currTrim);
    const isCmdContinuation = !prevEndsTerminalPunct && (
      CMD_ARG_CONT_RE.test(currTrim) ||
      /[|=\\]$/.test(prevTrim) ||
      /\s(-[a-zA-Z0-9]+|--[a-zA-Z0-9-]+)$/.test(prevTrim)
    );

    if (isTuiIndentedWrap || isLowerContinuation || isCmdContinuation) {
      out[out.length - 1] = `${prev} ${currTrim}`;
      continue;
    }

    out.push(currRaw);
  }

  return out.join("\n");
}

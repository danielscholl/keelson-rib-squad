// Trailing-directive JSON parsing for the coordinator's manager turn — the proven
// shape from chamber's routing.ts. A model writes its reasoning as prose and ENDS with
// a single JSON control object; we keep the LAST balanced top-level {...} (a
// string-aware brace scan, NOT a fenced block or sentinel), require it to be genuinely
// trailing (only whitespace after it), and route only on a known `action`. Malformed /
// missing / non-trailing JSON returns null so the caller falls back deterministically;
// `head` is the visible prose with the directive removed.

// A control directive is TRAILING by contract, so only the tail can hold it. Cap the
// scanned window so a brace-heavy body (the balanced-brace search retries from each
// unclosed `{`) can't drive the scan quadratic and block the event loop.
const MAX_SCAN = 32 * 1024;

export function extractTrailingJsonObject(text: string): string | null {
  const scan = text.length > MAX_SCAN ? text.slice(text.length - MAX_SCAN) : text;
  let last: string | null = null;
  let i = 0;
  while (i < scan.length) {
    const start = scan.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < scan.length; j++) {
      const ch = scan[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      i = start + 1; // unbalanced candidate — retry from the next "{"
      continue;
    }
    last = scan.slice(start, end + 1);
    i = end + 1;
  }
  return last;
}

export interface TrailingDirective {
  parsed: Record<string, unknown>;
  // The prose before the directive (the directive stripped), trimmed.
  head: string;
}

export function parseTrailingDirective(
  text: string,
  actions: ReadonlySet<string>,
): TrailingDirective | null {
  const json = extractTrailingJsonObject(text);
  if (!json) return null;
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return null; // not a tail
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null; // not JSON
  }
  if (typeof parsed.action !== "string" || !actions.has(parsed.action)) return null;
  return { parsed, head: text.slice(0, idx).trimEnd() };
}

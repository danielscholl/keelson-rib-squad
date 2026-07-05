import type { ReviewThread } from "./resolve-review.ts";

export type ReviewDisposition = {
  threadRef: string;
  disposition: "fixed" | "declined";
  note: string;
};

export type ReviewDispositionParseResult =
  | { ok: true; dispositions: Map<string, ReviewDisposition> }
  | { ok: false; reason: string };

function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  // No \s* after the fence label — it overlaps the lazy body match and turns
  // unclosed-fence input polynomial (js/polynomial-redos); the body is trimmed
  // below, so leading whitespace never survives anyway.
  const re = /```(?:json)?([\s\S]*?)```/gi;
  for (const match of text.matchAll(re)) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

export function parseReviewDispositions(
  transcriptTail: string,
  threads: readonly ReviewThread[],
): ReviewDispositionParseResult {
  const blocks = extractFencedBlocks(transcriptTail);
  if (blocks.length === 0) return { ok: false, reason: "missing fenced JSON disposition block" };
  const knownRefs = new Set(threads.map((t) => t.threadRef));
  for (const block of blocks.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const dispositions = new Map<string, ReviewDisposition>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        return { ok: false, reason: "disposition block must be an array of objects" };
      }
      const row = item as Record<string, unknown>;
      const threadRef = typeof row.threadRef === "string" ? row.threadRef.trim() : "";
      if (!threadRef || !knownRefs.has(threadRef)) {
        return { ok: false, reason: `unknown review threadRef "${threadRef || "(missing)"}"` };
      }
      const disposition = row.disposition;
      if (disposition !== "fixed" && disposition !== "declined") {
        return {
          ok: false,
          reason: `unknown disposition for ${threadRef}: ${String(disposition)}`,
        };
      }
      const note = typeof row.note === "string" ? row.note.trim() : "";
      dispositions.set(threadRef, { threadRef, disposition, note });
    }
    const missing = threads.map((t) => t.threadRef).filter((ref) => !dispositions.has(ref));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `missing dispositions for review threads: ${missing.join(", ")}`,
      };
    }
    return { ok: true, dispositions };
  }
  return { ok: false, reason: "malformed fenced JSON disposition block" };
}

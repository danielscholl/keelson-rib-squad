// Slug utilities for members: derive a path-safe directory slug from a name and
// guard it against traversal. Member *authoring* lives in the squad-genesis
// workflow + the squad_emit_member tool; this file is just the naming/safety
// primitives they and the member store share.

const SLUG_MAX = 48;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(name: string): string {
  const ascii = name
    // NFKD splits an accented letter into base + combining mark; the base stays
    // ASCII ("Café" -> "cafe") and the mark is dropped by the [^a-z0-9] filter
    // below (instead of the whole letter, which would mangle it to "caf").
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  // A name in a non-Latin script (CJK, Arabic…) reduces to empty; fall back to a
  // deterministic slug so it can still be created rather than rejected outright.
  return ascii || `member-${stableHash(name)}`;
}

export function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Guard against path traversal: a slug becomes a directory name under the data
// home, so reject anything that isn't a bare kebab token (no `/`, `..`, etc.).
export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) throw new Error(`unsafe member slug: ${JSON.stringify(slug)}`);
}

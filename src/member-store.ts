import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeSlug } from "./genesis.ts";
import type { Member, MemberStatus } from "./types.ts";

// File-based member persistence. One directory per member under the data home's
// members/ root; `member.json` is the structured record the roster reads and
// charter.md is the authored identity doc. `membersRoot` is injected so the store
// is testable against a temp dir and the env-based path resolution stays in
// paths.ts (the only thing the collector and the handlers share).

// member.json — the on-disk record. A superset of the chat-facing Member: it also
// keeps createdAt for stable, newest-first ordering.
export interface MemberRecord {
  slug: string;
  name: string;
  role: string;
  charter: string;
  status: MemberStatus;
  model?: string;
  provider?: string;
  tools?: readonly string[];
  // Themed-casting identity (#16) — persisted so the roster card and the charter
  // composer carry the character's voice. Optional/back-compat.
  themeId?: string;
  personality?: string;
  backstory?: string;
  originalName?: string;
  createdAt: string;
}

const SEED_DOCS: Record<string, () => string> = {
  "memory.md": () => "# Working memory\n\n_(empty)_\n",
  "rules.md": () => "# Rules\n\n_(none yet)_\n",
};

export async function scaffoldMember(membersRoot: string, record: MemberRecord): Promise<void> {
  assertSafeSlug(record.slug);
  const dir = join(membersRoot, record.slug);
  // Fail closed on collision: a re-genesis under an existing slug would clobber a
  // member's authored charter. Refuse and let the caller surface it.
  if (await exists(dir)) throw new Error(`member '${record.slug}' already exists`);

  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, "member.json"), `${JSON.stringify(record, null, 2)}\n`);
  await atomicWrite(join(dir, "charter.md"), ensureTrailingNewline(record.charter));
  for (const [file, seed] of Object.entries(SEED_DOCS)) {
    await atomicWrite(join(dir, file), seed());
  }
  await atomicWrite(
    join(dir, "log.md"),
    `# Log\n\n- ${record.createdAt} — genesis: authored from brief (role: ${record.role}).\n`,
  );
}

// Defense-in-depth cap on a batch scaffold (the cast proposal is already capped at
// propose time; this guards a hand-edited cast-proposal.json). Truncation is
// surfaced in the result, never silent.
export const MAX_BATCH_SCAFFOLD = 12;

export interface ScaffoldRosterResult {
  created: string[];
  // Slugs skipped because a member already exists — collision-safe by design: a
  // batch never clobbers an authored member (charter, memory, log).
  skipped: string[];
  // Members dropped by the cap.
  truncated: number;
}

// Scaffold a whole roster from pre-built records in one pass. Collision-safe: an
// existing slug is skipped (the authored member stands), so re-casting over a
// populated roster only adds. Member-capped, with truncation surfaced. Real I/O
// errors propagate (only a collision is a skip) so a half-written batch can't pass
// as success. Two records that slugify to the same slug collide in-batch — the
// first wins, the rest skip.
export async function scaffoldRoster(
  membersRoot: string,
  records: readonly MemberRecord[],
  opts: { maxMembers?: number } = {},
): Promise<ScaffoldRosterResult> {
  const max = Math.max(1, opts.maxMembers ?? MAX_BATCH_SCAFFOLD);
  const capped = records.slice(0, max);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const rec of capped) {
    assertSafeSlug(rec.slug);
    if (await exists(join(membersRoot, rec.slug))) {
      skipped.push(rec.slug);
      continue;
    }
    await scaffoldMember(membersRoot, rec);
    created.push(rec.slug);
  }
  return { created, skipped, truncated: records.length - capped.length };
}

// Read every member's record back, newest first, KEEPING the server-stamped
// createdAt the chat-facing readMembers drops. Degrades per entry: a directory
// without a parseable member.json is skipped, not fatal, so one corrupt member
// can't blank the whole roster.
export async function listMemberRecords(
  membersRoot: string,
): Promise<(Member & { createdAt: string })[]> {
  let entries: string[];
  try {
    entries = await readdir(membersRoot);
  } catch {
    return []; // no members/ yet — nothing has been authored
  }

  const records: (Member & { createdAt: string })[] = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(membersRoot, slug, "member.json"), "utf8");
      const rec = JSON.parse(raw) as Partial<MemberRecord>;
      // A cast is compile-time only: validate the shape and take the *directory*
      // name as the authoritative slug. So a drifted/partial member.json (missing
      // fields, slug diverging from the dir) is skipped or corrected here rather
      // than crashing the sort/map and blanking the roster.
      if (typeof rec !== "object" || rec === null) continue;
      if (typeof rec.name !== "string" || typeof rec.charter !== "string") continue;
      records.push({
        slug,
        name: rec.name,
        role: typeof rec.role === "string" && rec.role ? rec.role : "",
        charter: rec.charter,
        status: rec.status === "inactive" ? "inactive" : "active",
        createdAt: typeof rec.createdAt === "string" ? rec.createdAt : "",
        // Provider-primary coherence at the read boundary: a model is surfaced only
        // with its provider, so a legacy model-only record (written before the rule)
        // reads as unpinned rather than reaching a turn as a stray model on the default
        // provider. Consumers (dispatch, code, seed) therefore never see model-only.
        ...(typeof rec.provider === "string" && rec.provider ? { provider: rec.provider } : {}),
        ...(typeof rec.provider === "string" &&
        rec.provider &&
        typeof rec.model === "string" &&
        rec.model
          ? { model: rec.model }
          : {}),
        ...(Array.isArray(rec.tools) && rec.tools.length > 0
          ? { tools: rec.tools.filter((t): t is string => typeof t === "string") }
          : {}),
        ...(typeof rec.themeId === "string" && rec.themeId ? { themeId: rec.themeId } : {}),
        ...(typeof rec.personality === "string" && rec.personality
          ? { personality: rec.personality }
          : {}),
        ...(typeof rec.backstory === "string" && rec.backstory ? { backstory: rec.backstory } : {}),
        ...(typeof rec.originalName === "string" && rec.originalName
          ? { originalName: rec.originalName }
          : {}),
      });
    } catch {
      // skip non-member dirs / unreadable records
    }
  }

  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return records;
}

// Read every member back as the chat-facing shape, newest first — the roster +
// agents source.
export async function readMembers(membersRoot: string): Promise<Member[]> {
  const records = await listMemberRecords(membersRoot);
  return records.map((r) => ({
    slug: r.slug,
    name: r.name,
    role: r.role,
    charter: r.charter,
    status: r.status,
    ...(r.model ? { model: r.model } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.tools && r.tools.length > 0 ? { tools: r.tools } : {}),
    ...(r.themeId ? { themeId: r.themeId } : {}),
    ...(r.personality ? { personality: r.personality } : {}),
    ...(r.backstory ? { backstory: r.backstory } : {}),
    ...(r.originalName ? { originalName: r.originalName } : {}),
  }));
}

export async function readMember(membersRoot: string, slug: string): Promise<Member | undefined> {
  return (await readMembers(membersRoot)).find((m) => m.slug === slug);
}

// Read one of a member's authored docs (charter.md, memory.md, rules.md, log.md)
// by name. Returns undefined on any miss (no such member, empty/unreadable file,
// unsafe slug) and never throws, so a composer can fall back to the record's
// charter rather than crash. assertSafeSlug is inside the try so an unsafe slug
// returns undefined (no read) rather than rejecting the await.
export async function readMemberDoc(
  membersRoot: string,
  slug: string,
  file: string,
): Promise<string | undefined> {
  try {
    assertSafeSlug(slug);
    const text = await readFile(join(membersRoot, slug, file), "utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// The hard cap on a member's memory.md, enforced at the reflection write seam.
// The chat composer budgets the whole system prompt to MEMBER_PROMPT_BUDGET, of
// which the charter is the protected core; capping memory well under that keeps a
// populated memory from crowding identity out on read. A write over the cap is
// rejected (the prior memory stands), not silently truncated, so the on-disk doc
// always matches what was authored. Mirrors chamber's MEMORY_DOC_CAP.
export const MEMORY_DOC_CAP = 4000;

// Overwrite a member's memory.md with the consolidated text — the WHOLE new
// document, not an append, so a reflection revises in place rather than the store
// merging. Fails closed: an unsafe slug, a missing member, or over-cap text all
// throw, leaving the prior memory untouched.
export async function writeMemory(membersRoot: string, slug: string, text: string): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(membersRoot, slug);
  if (!(await exists(dir))) throw new Error(`member '${slug}' not found`);
  const body = text.trim();
  if (body.length > MEMORY_DOC_CAP) {
    throw new Error(`memory exceeds ${MEMORY_DOC_CAP} chars (got ${body.length})`);
  }
  await atomicWrite(join(dir, "memory.md"), ensureTrailingNewline(body));
}

export async function retireMember(membersRoot: string, slug: string): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(membersRoot, slug);
  if (!(await exists(dir))) throw new Error(`member '${slug}' not found`);
  await rm(dir, { recursive: true, force: true });
}

export async function setMemberModel(
  membersRoot: string,
  slug: string,
  pin: { model?: string; provider?: string },
): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(membersRoot, slug);
  if (!(await exists(dir))) throw new Error(`member '${slug}' not found`);

  const rec = JSON.parse(await readFile(join(dir, "member.json"), "utf8")) as MemberRecord;
  const model = pin.model?.trim();
  const provider = pin.provider?.trim();
  // A model is vendor-specific, so a pinned model needs its provider; a provider may
  // stand alone (pin the vendor, let it pick the model) — the mixed-provider team case
  // (e.g. a copilot triager with no model pin).
  if (model && !provider) {
    throw new Error("a pinned model needs its provider — set provider alongside model");
  }

  if (provider) {
    rec.provider = provider;
    if (model) rec.model = model;
    else delete rec.model;
  } else {
    delete rec.model;
    delete rec.provider;
  }

  await atomicWrite(join(dir, "member.json"), `${JSON.stringify(rec, null, 2)}\n`);
}

// Keep only the most recent entries so a member's journal can't grow without
// bound; the chat composer only tail-reads the log anyway, so older lines earn
// no keep.
export const LOG_MAX_ENTRIES = 50;

// Per-entry character cap. LOG_MAX_ENTRIES bounds the COUNT; this bounds each
// bullet — together they cap log.md's size regardless of caller.
export const LOG_ENTRY_CAP = 280;

// Append one timestamped line to a member's log.md and trim to the last
// LOG_MAX_ENTRIES entries. Fails closed on an unsafe slug or a missing member.
// The line is collapsed to a single physical line so one entry stays one bullet,
// and capped so a runaway line can't bloat the journal.
export async function appendLog(
  membersRoot: string,
  slug: string,
  line: string,
  at: string,
): Promise<void> {
  assertSafeSlug(slug);
  const dir = join(membersRoot, slug);
  if (!(await exists(dir))) throw new Error(`member '${slug}' not found`);
  const entry = `- ${at} — ${line.replace(/\s+/g, " ").trim()}`.slice(0, LOG_ENTRY_CAP);
  let existing: string;
  try {
    existing = await readFile(join(dir, "log.md"), "utf8");
  } catch (e) {
    // Only a missing log starts fresh; a permission/I/O error must surface, or the
    // next append would rewrite log.md from just this entry and drop the journal.
    if (!isNodeError(e) || e.code !== "ENOENT") throw e;
    existing = "# Log\n";
  }
  const lines = existing.split("\n");
  const header = lines[0]?.startsWith("#") ? lines[0] : "# Log";
  const bullets = lines.filter((l) => l.trimStart().startsWith("- "));
  const kept = [...bullets, entry].slice(-LOG_MAX_ENTRIES);
  await atomicWrite(join(dir, "log.md"), `${header}\n\n${kept.join("\n")}\n`);
}

// A Node fs error carrying an errno `code`, so a not-found read can be told apart
// from a real I/O/permission failure.
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

// stat, not readdir: readdir only succeeds on a directory, so a non-directory
// entry at the path would read as absent and silently bypass the collision /
// not-found guards.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// Write a member file atomically (temp + rename, like the casting registry). A crash
// mid-write would otherwise leave a torn member.json that listMemberRecords skips —
// making the member vanish from the roster while its dir still blocks re-creation.
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

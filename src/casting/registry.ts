import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "@keelson/shared";
import { slugify } from "../genesis.ts";
import { assignCharacter, type ThemeUsage, themeSelectionOrder } from "./engine.ts";
import {
  type CanonicalRole,
  canonicalRole,
  findTheme,
  THEMES,
  type Theme,
  type ThemeCharacter,
  themeById,
  themeLabel,
} from "./themes.ts";

// The persistent casting registry — the squad's cast list under the data home. It
// records the active ensemble(s) and, per member slug, which character that member
// was cast as. It is the source of truth for uniqueness (an active name isn't
// reused), name stability (re-casting the same proposed name returns the same
// character), and lineage (retire frees a name; a later reuse links back to it).
// All reads are fail-soft — a missing or corrupt file reads as an empty registry so
// casting degrades to "fresh squad", never a crash.

export type CastingStatus = "active" | "retired";

export interface CastingEntry {
  themedName: string;
  themeId: string;
  status: CastingStatus;
  // The name the caller proposed (genesis name / cast proposal name) before casting
  // replaced it — the stable key re-casting matches on.
  originalName?: string;
  // Lineage: the prior cast's source name this member inherited a freed character
  // from (set on the new entry); and the slug that inherited THIS member's freed
  // name (set on the retired entry). Together they trace a name's hand-off.
  previousName?: string;
  succeededBy?: string;
}

// A character within an LLM-invented ensemble — same shape as a static
// ThemeCharacter, grown one entry at a time as members are cast into it.
export interface CustomThemeCharacter {
  name: string;
  personality: string;
  backstory: string;
  preferredRoles: CanonicalRole[];
}

// An LLM-invented ensemble, persisted per squad (not part of the static THEMES
// catalog). Created the first time an LLM proposal names a `newThemeLabel`;
// capped at CUSTOM_THEME_CAPACITY so it can exhaust and rotate like a static one.
export interface CustomTheme {
  label: string;
  characters: CustomThemeCharacter[];
}

export const CUSTOM_THEME_CAPACITY = 10;

export interface CastingRegistry {
  version: 1;
  // The squad's current ensemble — reused until exhausted, then rolled.
  activeThemeId?: string;
  // Ensembles in activation order (most-recent last) — the LRU input for selection.
  themeHistory: string[];
  // Keyed by member slug for active members; retired entries are archived under a
  // bookkeeping key so a reused name keeps both ends of its lineage.
  members: Record<string, CastingEntry>;
  // LLM-invented ensembles, keyed by minted theme id. Omitted when empty.
  customThemes?: Record<string, CustomTheme>;
}

// A casting decision proposed by an LLM turn (genesis or auto-cast), fed into
// assignThemedIdentity as a preferred rung ahead of the deterministic engine. Set
// `themeId` to reuse a known ensemble (static or already-invented custom), or
// `newThemeLabel` to invent one — never both. Validated by llmCastProposalSchema
// so the genesis/cast-scan tool schemas share one shape.
export interface LlmCastProposal {
  themeId?: string;
  newThemeLabel?: string;
  characterName: string;
  personality: string;
  backstory: string;
}

export const llmCastProposalSchema = z.object({
  themeId: z.string().min(1).optional(),
  newThemeLabel: z.string().min(1).optional(),
  characterName: z.string().min(1),
  personality: z.string().min(1),
  backstory: z.string().min(1),
});

const REGISTRY_FILE = "casting-registry.json";

function emptyRegistry(): CastingRegistry {
  return { version: 1, themeHistory: [], members: {} };
}

export async function loadRegistry(dataHome: string): Promise<CastingRegistry> {
  let raw: string;
  try {
    raw = await readFile(join(dataHome, REGISTRY_FILE), "utf8");
  } catch {
    return emptyRegistry(); // no registry yet — a fresh squad
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CastingRegistry>;
    if (typeof parsed !== "object" || parsed === null) return emptyRegistry();
    const rawMembers = parsed.members && typeof parsed.members === "object" ? parsed.members : {};
    const members: Record<string, CastingEntry> = {};
    for (const [key, e] of Object.entries(rawMembers as Record<string, Partial<CastingEntry>>)) {
      if (typeof e !== "object" || e === null) continue;
      if (typeof e.themedName !== "string" || typeof e.themeId !== "string") continue;
      members[key] = {
        themedName: e.themedName,
        themeId: e.themeId,
        status: e.status === "retired" ? "retired" : "active",
        ...(typeof e.originalName === "string" ? { originalName: e.originalName } : {}),
        ...(typeof e.previousName === "string" ? { previousName: e.previousName } : {}),
        ...(typeof e.succeededBy === "string" ? { succeededBy: e.succeededBy } : {}),
      };
    }
    const rawCustomThemes =
      parsed.customThemes && typeof parsed.customThemes === "object" ? parsed.customThemes : {};
    const customThemes: Record<string, CustomTheme> = {};
    for (const [id, t] of Object.entries(rawCustomThemes as Record<string, Partial<CustomTheme>>)) {
      if (typeof t !== "object" || t === null) continue;
      if (typeof t.label !== "string" || !t.label || !Array.isArray(t.characters)) continue;
      const characters: CustomThemeCharacter[] = [];
      for (const c of t.characters as Partial<CustomThemeCharacter>[]) {
        if (typeof c !== "object" || c === null) continue;
        if (
          typeof c.name !== "string" ||
          !c.name ||
          typeof c.personality !== "string" ||
          typeof c.backstory !== "string"
        ) {
          continue;
        }
        characters.push({
          name: c.name,
          personality: c.personality,
          backstory: c.backstory,
          preferredRoles: Array.isArray(c.preferredRoles)
            ? c.preferredRoles.filter((r): r is CanonicalRole => typeof r === "string")
            : [],
        });
      }
      customThemes[id] = { label: t.label, characters };
    }

    return {
      version: 1,
      ...(typeof parsed.activeThemeId === "string" ? { activeThemeId: parsed.activeThemeId } : {}),
      themeHistory: Array.isArray(parsed.themeHistory)
        ? parsed.themeHistory.filter((x): x is string => typeof x === "string")
        : [],
      members,
      ...(Object.keys(customThemes).length > 0 ? { customThemes } : {}),
    };
  } catch {
    return emptyRegistry(); // corrupt JSON reads as empty, never throws
  }
}

// Write the registry whole, via a temp file + rename so a crashed write can't leave
// a half-written (and then unreadable) registry.
export async function saveRegistry(dataHome: string, reg: CastingRegistry): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  const target = join(dataHome, REGISTRY_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  await rename(tmp, target);
}

// Serialize the registry's read-modify-write spans per data home. saveRegistry's
// temp+rename is atomic for a single write, but a cast does load→reserve→save, and two
// overlapping casts (an approve-cast over a genesis, or parallel genesis) can each
// reserve the same free character before either saves — the later save then clobbers
// the earlier reservation, breaking the uniqueness the registry exists to guarantee.
const registryLocks = new Map<string, Promise<unknown>>();

function withRegistryLock<T>(dataHome: string, fn: () => Promise<T>): Promise<T> {
  const prev = registryLocks.get(dataHome) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run fn after the prior holder settles, either way
  registryLocks.set(
    dataHome,
    run.catch(() => {}), // the next waiter chains on completion, never on rejection
  );
  return run;
}

export function usageOf(reg: CastingRegistry): ThemeUsage {
  const activeCountByTheme: Record<string, number> = {};
  for (const e of Object.values(reg.members)) {
    if (e.status === "active") {
      activeCountByTheme[e.themeId] = (activeCountByTheme[e.themeId] ?? 0) + 1;
    }
  }
  return {
    ...(reg.activeThemeId ? { activeThemeId: reg.activeThemeId } : {}),
    themeHistory: reg.themeHistory,
    activeCountByTheme,
  };
}

export function activeNames(reg: CastingRegistry): Set<string> {
  const names = new Set<string>();
  for (const e of Object.values(reg.members)) {
    if (e.status === "active") names.add(e.themedName);
  }
  return names;
}

function activeSlugs(reg: CastingRegistry): Set<string> {
  const slugs = new Set<string>();
  for (const [slug, e] of Object.entries(reg.members)) {
    if (e.status === "active") slugs.add(slug);
  }
  return slugs;
}

function findActiveByOriginal(
  reg: CastingRegistry,
  name: string,
): { slug: string; entry: CastingEntry } | undefined {
  for (const [slug, entry] of Object.entries(reg.members)) {
    if (entry.status === "active" && entry.originalName === name) return { slug, entry };
  }
  return undefined;
}

// The MOST-recently-retired entry for a character — archive keys are appended in
// retire order, so the last match is the freshest. Returning the first (oldest) would
// link a reuse's lineage to a stale ancestor and overwrite the recent retired entry.
function findRetiredByName(
  reg: CastingRegistry,
  themedName: string,
): { slug: string; entry: CastingEntry } | undefined {
  let found: { slug: string; entry: CastingEntry } | undefined;
  for (const [slug, entry] of Object.entries(reg.members)) {
    if (entry.status === "retired" && entry.themedName === themedName) found = { slug, entry };
  }
  return found;
}

function characterIn(themeId: string, name: string): ThemeCharacter | undefined {
  return themeById(themeId)?.characters.find((c) => c.name === name);
}

// Registry-aware sibling of characterIn: also checks a squad's custom (LLM-
// invented) ensembles, so re-casting the same proposed name for a member
// previously cast into a custom theme still returns its personality/backstory.
function characterInRegistry(
  reg: CastingRegistry,
  themeId: string,
  name: string,
): ThemeCharacter | undefined {
  return (
    characterIn(themeId, name) ??
    reg.customThemes?.[themeId]?.characters.find((c) => c.name === name)
  );
}

function resolveThemeLabel(reg: CastingRegistry, themeId: string): string {
  return themeById(themeId)?.label ?? reg.customThemes?.[themeId]?.label ?? themeId;
}

// Resolve an operator's theme pin against a squad's custom ensembles too (match
// by id or label, case-insensitive) — the companion to themes.ts's findTheme,
// which only searches the static catalog.
function findCustomTheme(reg: CastingRegistry, idOrLabel: string): Theme | undefined {
  const needle = idOrLabel.trim().toLowerCase();
  for (const [id, t] of Object.entries(reg.customThemes ?? {})) {
    if (id.toLowerCase() === needle || t.label.toLowerCase() === needle) {
      return { id, label: t.label, characters: t.characters };
    }
  }
  return undefined;
}

// The data home holds members/ (one dir per member) alongside the registry; a
// member dir can exist without a registry entry (authored before theming, or a
// deleted registry), so disk slugs are checked too for collision-safety.
async function existingMemberSlugs(dataHome: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(join(dataHome, "members")));
  } catch {
    return new Set();
  }
}

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

// --- theming config (operator escape hatch) -------------------------------------

export interface ThemingConfig {
  mode: "themed" | "off";
  // A pinned ensemble id or label (KEELSON_SQUAD_THEME) — forces that ensemble.
  pin?: string;
}

// Resolve the operator's theming preference from the environment. Theming is ON by
// default; KEELSON_SQUAD_THEMING=off (or 0/false) opts out (proposed names stand);
// KEELSON_SQUAD_THEME=<id|label> pins one ensemble.
export function resolveThemingConfig(
  env: Record<string, string | undefined> = process.env,
): ThemingConfig {
  const flag = (env.KEELSON_SQUAD_THEMING ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false" || flag === "none") {
    return { mode: "off" };
  }
  const pin = (env.KEELSON_SQUAD_THEME ?? "").trim();
  return { mode: "themed", ...(pin ? { pin } : {}) };
}

// --- the single intercept seam --------------------------------------------------

export interface ThemedIdentity {
  name: string;
  slug: string;
  themeId?: string;
  // The theme's human label, resolved against both the static catalog and a
  // squad's custom ensembles — persisted downstream so callers with no registry
  // access (e.g. the pure roster board) never have to re-derive it.
  themeLabel?: string;
  personality?: string;
  backstory?: string;
  // The proposed name the caller handed in (always present, even when theming is off
  // or exhausted, so the persisted member can record where it came from).
  originalName: string;
}

// The ONE place a proposed { name, role } becomes a final cast identity. Both
// genesis (squad_emit_member) and auto-cast (the approve/scaffold path) route
// through it, so the two theme with one code path. Loads the registry, reuses the
// squad's ensemble (or rolls to the next on exhaustion), assigns a best-fit
// character, reserves it (uniqueness + lineage), and persists. Slug-collision-safe
// against member dirs already on disk. Theming off / fully exhausted falls back to
// the proposed name.
//
// `llmProposal`, when supplied, is tried FIRST (after name-stability, before the
// deterministic walk): an LLM-authored theme/character that passes the same
// uniqueness checks as the deterministic engine is reserved directly, letting a
// squad's ensemble be reused, rerolled, or invented rather than permanently
// limited to the static catalog. Any rejection (invalid, colliding, pin mismatch,
// or simply absent) falls straight through to the unchanged deterministic engine —
// the LLM path is additive, never a replacement for the tested fallback.
export function assignThemedIdentity(
  dataHome: string,
  input: { proposedName: string; role: string; llmProposal?: LlmCastProposal },
  config: ThemingConfig = resolveThemingConfig(),
): Promise<ThemedIdentity> {
  // `off` touches no registry, so it needs no lock; everything else does a
  // load→reserve→save that must be serialized per data home (see withRegistryLock).
  if (config.mode === "off") {
    const proposedName = input.proposedName.trim() || "member";
    return Promise.resolve({
      name: proposedName,
      slug: slugify(proposedName),
      originalName: proposedName,
    });
  }
  return withRegistryLock(dataHome, () => assignThemedIdentityLocked(dataHome, input, config));
}

async function assignThemedIdentityLocked(
  dataHome: string,
  input: { proposedName: string; role: string; llmProposal?: LlmCastProposal },
  config: ThemingConfig,
): Promise<ThemedIdentity> {
  const proposedName = input.proposedName.trim() || "member";

  const reg = await loadRegistry(dataHome);

  // Name stability: a live member already cast for this proposed name keeps its
  // character, so re-casting the same project is idempotent (the existing member is
  // then skipped on disk rather than duplicated under a new name) — this outranks a
  // fresh llmProposal exactly as it already outranks the deterministic walk.
  const stable = findActiveByOriginal(reg, proposedName);
  if (stable) {
    const ch = characterInRegistry(reg, stable.entry.themeId, stable.entry.themedName);
    return {
      name: stable.entry.themedName,
      slug: stable.slug,
      themeId: stable.entry.themeId,
      themeLabel: resolveThemeLabel(reg, stable.entry.themeId),
      ...(ch ? { personality: ch.personality, backstory: ch.backstory } : {}),
      originalName: proposedName,
    };
  }

  const existing = await existingMemberSlugs(dataHome);
  const takenSlugs = new Set<string>([...existing, ...activeSlugs(reg)]);
  const takenNames = activeNames(reg);

  if (input.llmProposal) {
    const resolved = resolveLlmProposal(
      reg,
      input.llmProposal,
      input.role,
      config,
      takenNames,
      takenSlugs,
    );
    if (resolved) {
      return reserveThemedIdentity(dataHome, reg, resolved, proposedName);
    }
  }

  // A pin forces one ensemble; otherwise walk the selection order, rolling to the
  // next ensemble when the current one has no free character for the role.
  const order = config.pin ? pinnedOrder(config.pin, reg) : themeSelectionOrder(usageOf(reg));
  let chosen: { theme: Theme; char: ThemeCharacter } | undefined;
  for (const theme of order) {
    // Also rule out a character whose slug already exists on disk (collision-safe).
    const localTaken = new Set(takenNames);
    for (const c of theme.characters) {
      if (takenSlugs.has(slugify(c.name))) localTaken.add(c.name);
    }
    const char = assignCharacter(input.role, theme, localTaken);
    if (char) {
      chosen = { theme, char };
      break;
    }
  }

  if (!chosen) {
    // Every ensemble exhausted — keep the proposed name, made slug-unique.
    const slug = uniqueSlug(slugify(proposedName), takenSlugs);
    return { name: proposedName, slug, originalName: proposedName };
  }

  return reserveThemedIdentity(
    dataHome,
    reg,
    {
      theme: { id: chosen.theme.id, label: chosen.theme.label },
      char: chosen.char,
      isNewCustomCharacter: false,
    },
    proposedName,
  );
}

// Validate and resolve an LLM-authored proposal against the squad's current
// registry state. Returns undefined on ANY rejection (malformed, colliding name,
// pin mismatch, unknown theme id, or a static theme that doesn't actually carry
// the named character — static rosters are fixed in v1, only custom ensembles
// grow) so the caller falls straight through to the deterministic engine.
function resolveLlmProposal(
  reg: CastingRegistry,
  proposal: LlmCastProposal,
  role: string,
  config: ThemingConfig,
  takenNames: ReadonlySet<string>,
  takenSlugs: ReadonlySet<string>,
):
  | { theme: { id: string; label: string }; char: ThemeCharacter; isNewCustomCharacter: boolean }
  | undefined {
  const characterName = proposal.characterName.trim();
  if (!characterName) return undefined;
  if (takenNames.has(characterName)) return undefined;
  if (takenSlugs.has(slugify(characterName))) return undefined;

  let themeId = proposal.themeId?.trim() || undefined;
  let newLabel = proposal.newThemeLabel?.trim() || undefined;
  if (!themeId && newLabel) {
    // Reuse an ensemble the label already names (static or custom) instead of
    // minting a duplicate universe under a fresh id.
    themeId = findTheme(newLabel)?.id ?? findCustomTheme(reg, newLabel)?.id;
    if (themeId) newLabel = undefined;
  }
  if (!themeId && !newLabel) return undefined; // named nothing usable

  if (config.pin) {
    const pinned = findTheme(config.pin) ?? findCustomTheme(reg, config.pin);
    if (pinned) {
      if (themeId !== pinned.id) return undefined;
    } else {
      // The pin itself isn't a known theme yet — only accept a proposal that
      // invents exactly that universe.
      if (!newLabel || newLabel.toLowerCase() !== config.pin.trim().toLowerCase()) return undefined;
    }
  }

  if (themeId) {
    const staticTheme = themeById(themeId);
    if (staticTheme) {
      const char = staticTheme.characters.find((c) => c.name === characterName);
      return char
        ? {
            theme: { id: staticTheme.id, label: staticTheme.label },
            char,
            isNewCustomCharacter: false,
          }
        : undefined;
    }
    const custom = reg.customThemes?.[themeId];
    if (!custom) return undefined;
    const existingChar = custom.characters.find((c) => c.name === characterName);
    if (existingChar) {
      return {
        theme: { id: themeId, label: custom.label },
        char: existingChar,
        isNewCustomCharacter: false,
      };
    }
    if (custom.characters.length >= CUSTOM_THEME_CAPACITY) return undefined;
    return {
      theme: { id: themeId, label: custom.label },
      char: newCustomCharacter(characterName, proposal, role),
      isNewCustomCharacter: true,
    };
  }

  // Minting a brand-new custom theme.
  const id = uniqueThemeId(slugify(newLabel!), reg);
  return {
    theme: { id, label: newLabel! },
    char: newCustomCharacter(characterName, proposal, role),
    isNewCustomCharacter: true,
  };
}

function newCustomCharacter(name: string, proposal: LlmCastProposal, role: string): ThemeCharacter {
  return {
    name,
    personality: proposal.personality,
    backstory: proposal.backstory,
    preferredRoles: [canonicalRole(role)],
  };
}

function uniqueThemeId(base: string, reg: CastingRegistry): string {
  const taken = new Set<string>([
    ...THEMES.map((t) => t.id),
    ...Object.keys(reg.customThemes ?? {}),
  ]);
  return uniqueSlug(base, taken);
}

// Shared reservation tail for both the LLM rung and the deterministic-engine rung:
// record ensemble (re)activation, grow a custom theme's roster when the character
// is new, splice retire/reuse lineage, persist, and return the settled identity.
async function reserveThemedIdentity(
  dataHome: string,
  reg: CastingRegistry,
  chosen: {
    theme: { id: string; label: string };
    char: ThemeCharacter;
    isNewCustomCharacter: boolean;
  },
  proposedName: string,
): Promise<ThemedIdentity> {
  const { theme, char, isNewCustomCharacter } = chosen;
  const slug = slugify(char.name);

  // Record the ensemble's (re)activation for the LRU rule when it changes.
  if (reg.activeThemeId !== theme.id) {
    reg.activeThemeId = theme.id;
    reg.themeHistory.push(theme.id);
  }

  if (isNewCustomCharacter) {
    const custom = reg.customThemes?.[theme.id] ?? { label: theme.label, characters: [] };
    custom.characters.push({
      name: char.name,
      personality: char.personality,
      backstory: char.backstory,
      preferredRoles: char.preferredRoles,
    });
    reg.customThemes = { ...(reg.customThemes ?? {}), [theme.id]: custom };
  }

  // Lineage: reusing a freed (retired) character links the two — archive the retired
  // entry (so the clean slug is free for the active one) and cross-reference them.
  const predecessor = findRetiredByName(reg, char.name);
  const entry: CastingEntry = {
    themedName: char.name,
    themeId: theme.id,
    status: "active",
    originalName: proposedName,
    ...(predecessor?.entry.originalName ? { previousName: predecessor.entry.originalName } : {}),
  };
  if (predecessor) {
    delete reg.members[predecessor.slug];
    reg.members[archiveKey(reg, slug)] = { ...predecessor.entry, succeededBy: slug };
  }
  reg.members[slug] = entry;
  await saveRegistry(dataHome, reg);

  return {
    name: char.name,
    slug,
    themeId: theme.id,
    themeLabel: theme.label,
    personality: char.personality,
    backstory: char.backstory,
    originalName: proposedName,
  };
}

function pinnedOrder(pin: string, reg: CastingRegistry): Theme[] {
  const theme = findTheme(pin) ?? findCustomTheme(reg, pin);
  return theme ? [theme] : themeSelectionOrder(usageOf(reg));
}

// A non-colliding bookkeeping key for a retired entry whose clean slug is being
// reclaimed by a new active member, so the registry keeps both ends of the lineage.
function archiveKey(reg: CastingRegistry, slug: string): string {
  for (let n = 1; ; n++) {
    const key = `${slug}#retired-${n}`;
    if (!(key in reg.members)) return key;
  }
}

// Retire a member's cast entry: mark it retired so its name returns to the pool for
// reuse. Fail-soft — an unknown/already-retired slug is a no-op, and a missing/
// corrupt registry just yields nothing to free. Never throws (it is wired in after
// the member is already removed; a registry hiccup must not fail the retire).
export async function retireCastingName(dataHome: string, slug: string): Promise<void> {
  await withRegistryLock(dataHome, async () => {
    try {
      const reg = await loadRegistry(dataHome);
      const entry = reg.members[slug];
      if (!entry || entry.status === "retired") return;
      entry.status = "retired";
      await saveRegistry(dataHome, reg);
    } catch {
      // best-effort: the member dir is already gone; the freed name just won't reflect
    }
  });
}

// --- charter folding ------------------------------------------------------------

const HEADING_RE = /^#\s+.*(?:\n|$)/;

// Fold the cast character's voice into the member's charter as a short preamble so
// compose.ts carries it into the system prompt. The original charter's own H1 is
// dropped (the themed name replaces it) and its `## Role/Mission/Voice` body is kept
// intact. compose.ts re-clamps to the prompt budget, so length stays bounded here.
export function foldThemedCharter(
  charter: string,
  themed: {
    name: string;
    personality: string;
    backstory: string;
    themeLabel: string;
    originalName?: string;
  },
): string {
  let body = charter.trim();
  const h1 = body.match(HEADING_RE);
  if (h1) body = body.slice(h1[0].length).trim();
  const prior = themed.originalName?.trim();
  if (prior && prior !== themed.name) {
    const re = new RegExp(`\\b${prior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    body = body.replace(re, () => themed.name);
  }
  const preamble = [
    `# ${themed.name}`,
    "",
    `_Cast from ${themed.themeLabel}._`,
    "",
    `**Personality.** ${themed.personality}`,
    `**Backstory.** ${themed.backstory}`,
  ].join("\n");
  return body ? `${preamble}\n\n${body}` : preamble;
}

// Re-export for callers that build a record from a themed identity.
export { themeLabel };

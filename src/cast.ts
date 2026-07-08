import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RibAgentTurn, RibAgentTurnResult, RibContext } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import { type CastingOptionsView, castingOptions } from "./casting/options.ts";
import {
  type LlmCastProposal,
  llmCastProposalSchema,
  loadRegistry,
  resolveThemingConfig,
} from "./casting/registry.ts";
import { assignableProviders, validateProviderPin } from "./provider-pins.ts";
import { normalizeIdentitySlot, normalizeToolAllowlist } from "./types.ts";

// Auto-cast: inspect a project and propose the team best suited to it. This is the
// defining capability — chamber hand-authors each Mind; squad reads the repo and
// composes the roster. Built on an INJECTED runAgentTurn (the host seam), like
// dispatch.ts, so the scan is unit-testable against a fake. The scan turn is
// READ-ONLY and CONFINED to the project root (cwd + allowedDirectories + a
// read-only tool rail); scaffolding the approved members is the only write, and it
// happens later, on approve.

// The read-only rail the scan turn runs under. allowedTools present means "these
// and no others" at the host (see apps/server rib-agent-turn.ts), so Bash/Edit/
// Write are excluded — the scan can read the repo but never modify it.
export const SCAN_TOOLS = ["Read", "Glob", "Grep"] as const;

// Cap the proposed team so a runaway scan can't author dozens of members. The
// truncation is surfaced as a note, never silent.
export const MAX_CAST_MEMBERS = 6;

const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

// The structured roster the scan turn must return. Lenient on the optionals
// (model/provider/tools) and strict on the identity core (name/role/charter), so a
// partial-but-usable proposal still parses. Capability `tools` are free-form here
// (deduped/trimmed later), matching Phase 0's squad_emit_member — the prompt steers
// the model toward the code/read vocabulary the coordinator will route on.
const castMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  charter: z.string().min(1),
  tools: z.array(z.string()).optional(),
  toolAllowlist: z.array(z.string()).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  // The casting decision for this member, from the SAME scan turn — informed by
  // the casting-context block scanPrompt renders. Consumed by themedProposal
  // (index.ts) right after the scan returns; never itself persisted.
  castAs: llmCastProposalSchema.optional(),
});
export const castProposalSchema = z.object({
  members: z.array(castMemberSchema).min(1),
  summary: z.string().optional(),
});

// One proposed member, normalized (tools deduped/trimmed). The persisted/board shape.
export interface CastProposalMember {
  slug?: string;
  name: string;
  role: string;
  charter: string;
  tools?: string[];
  toolAllowlist?: string[];
  model?: string;
  provider?: string;
  themeId?: string;
  themeLabel?: string;
  personality?: string;
  backstory?: string;
  originalName?: string;
  identitySlot?: number;
  // Transient: the scan turn's casting decision, read by themedProposal and
  // replaced by themeId/themeLabel/personality/backstory before the proposal is
  // written to disk — never round-trips through writeProposal/readProposal.
  castAs?: LlmCastProposal;
}

// The pending proposal persisted to cast-proposal.json and rendered by the
// squad-cast collector. Carries the project it was cast for so the board can label
// it and approve can run without re-resolving; `notes` surfaces a member-cap
// truncation; `summary` is the scan's optional one-line description of the team.
export interface CastProposalRecord {
  projectId: string;
  projectName: string;
  rootPath: string;
  mission?: string;
  members: CastProposalMember[];
  summary?: string;
  notes: string[];
  createdAt: string;
}

export type ProposeCastResult =
  | { ok: true; proposal: CastProposalRecord }
  | { ok: false; error: string };

export interface ProposeCastOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  project: { id: string; name: string; rootPath: string };
  mission?: string;
  maxMembers?: number;
  // The providers registered on this harness (RibContext.getProviders). When supplied
  // and non-empty, the scan turn is asked to assign each member a provider/model from
  // these — matched to its role, leaning overpowered. Empty/omitted leaves members
  // unpinned (the harness default provider serves every turn).
  providers?: ReturnType<NonNullable<RibContext["getProviders"]>>;
  // The selection's scoped data home — read here (before the scan turn runs) to
  // build the casting-context block the whole team is cast from in one pass,
  // rather than one runAgentTurn call per proposed member. Omitted degrades to a
  // fresh/untheed registry (loadRegistry reads a blank path as "no file yet").
  dataHome?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const SCAN_SYSTEM =
  "You are a staffing architect for a Keelson Squad — a small team of persistent AI agents an operator talks to directly. You inspect a real software project and propose the team best suited to the work in it. You read the repository to staff it well; you never modify it.";

// Render the squad's casting state as prompt text so the SAME scan turn that
// proposes the team can also cast it — no second runAgentTurn per member. Mirrors
// the guidance genesis's squad_casting_options tool result carries, minus the
// tool-call step (the scan turn is read-only/confined and can't call rib tools).
function castingContextBlock(ctx: CastingOptionsView): string {
  if (ctx.mode === "off") return "";
  const active = ctx.activeTheme
    ? `Active ensemble: "${ctx.activeTheme.label}" (id "${ctx.activeTheme.id}"), ${ctx.activeTheme.remainingCapacity} character(s) still free — prefer reusing it while it has room.`
    : "No ensemble active yet for this squad — this cast starts fresh.";
  const history =
    ctx.themeHistory.length > 0
      ? ` Used before (oldest first, prefer freshness): ${ctx.themeHistory.join(", ")}.`
      : "";
  const catalog = ctx.catalog
    .map((t) => `"${t.label}" (id "${t.id}"): ${t.characterNames.join(", ")}`)
    .join("; ");
  const custom =
    ctx.customThemes.length > 0
      ? ` This squad has already invented: ${ctx.customThemes
          .map(
            (t) =>
              `"${t.label}" (id "${t.id}", ${t.remainingCapacity} free): ${t.characterNames.join(", ")}`,
          )
          .join("; ")}.`
      : "";
  const taken =
    ctx.takenCharacterNames.length > 0
      ? ` Already-taken character names (never reuse, and never repeat one across members in THIS proposal): ${ctx.takenCharacterNames.join(", ")}.`
      : "";
  const pin = ctx.pin
    ? ` The operator has pinned casting to "${ctx.pin}" — only cast within that exact ensemble (invent it via castAs.newThemeLabel matching the pin if it isn't a known ensemble yet).`
    : "";
  return `

Casting context: ${active}${history}${custom}${taken}${pin}
Catalog ensembles (inspiration, not a limit — invent a fresh one via castAs.newThemeLabel if it fits the project better): ${catalog}`;
}

function scanPrompt(
  projectName: string,
  mission: string | undefined,
  maxMembers: number,
  providers: readonly { id: string; displayName?: string }[],
  castingContext: CastingOptionsView,
): string {
  const missionBlock = mission
    ? `\nThe operator's mission for this squad:\n---\n${mission}\n---\n`
    : "";
  // Only ask for provider/model assignment when the harness actually exposes the
  // registered set; otherwise members come back unpinned and run on the default.
  const assignBlock =
    providers.length > 0
      ? `\n- provider (and optionally model): the engine this member runs on. The providers AVAILABLE on this harness are: ${providers.map((p) => JSON.stringify(p.id)).join(", ")}. Use ONLY these provider ids. Match the engine to the role, and when unsure lean OVERPOWERED (a stronger model), never underpowered:
  · planning / coordination / lead / architect roles → prefer "claude" with an Opus-class model (e.g. "claude-opus-4-8") for planning + coordination strength
  · coding / implementation / review / QA roles → prefer "copilot" with a GPT-5.5-class model (e.g. "gpt-5.5") for coding + reviewing strength
  · generic / triage / support roles → "copilot" on its default model (omit "model")
  If a preferred provider is not in the AVAILABLE list, fall back to the strongest available one. A model REQUIRES its provider: if you set "model", set "provider" too; you may set "provider" alone (a vendor pin that uses the provider's default model). If unsure of a provider's exact model id, pin the provider alone and omit "model".`
      : "";
  const castingBlock = castingContextBlock(castingContext);
  const castInstructions =
    castingContext.mode === "off"
      ? ""
      : `\n- castAs (optional): a themed cast for this member — set castAs.themeId to reuse an ensemble (the active one, another catalog id, or one this squad already invented) with a characterName from ITS listed characters, or castAs.newThemeLabel to invent a fresh ensemble (never both) with any characterName. Every member's characterName must be distinct from every other member's in this same proposal, and from the already-taken names above. Always include personality and backstory in your own words. Spoiler/tone guard: prefer a character's earliest, most neutral identity (not a later-earned title or a twist/reveal name); do not cast a character whose reputation clashes with the role. Omit castAs for a member you'd rather leave with a plain name.`;
  const jsonExample =
    providers.length > 0
      ? `{"members":[{"name":"...","role":"...","charter":"...","tools":["read"],"provider":"claude","model":"claude-opus-4-8","castAs":{"themeId":"...","characterName":"...","personality":"...","backstory":"..."}}],"summary":"one line describing the team"}`
      : `{"members":[{"name":"...","role":"...","charter":"...","tools":["read"],"castAs":{"themeId":"...","characterName":"...","personality":"...","backstory":"..."}}],"summary":"one line describing the team"}`;
  return `Inspect the project at the current working directory ("${projectName}"). Use the read-only tools (Read, Glob, Grep) to learn what it actually is: its languages and frameworks, how the code is laid out, its docs, tests, and CI. Read enough to staff it well — do not modify anything.
${missionBlock}${castingBlock}
Propose the SMALL team (typically 3-5 members, never more than ${maxMembers}) best suited to THIS project and mission. For each member decide:
- name: a short proper handle (a person-like name, NOT a job title) — this is the plain fallback used verbatim if casting is off or your castAs is rejected, so make it sensible on its own
- role: a 1-4 word role title (e.g. "Backend Engineer", "Reviewer", "Tech Lead")
- charter: a Markdown identity doc with these sections in order — "# <name>", "## Role", "## Mission", "## Voice" — grounded in what you actually found in the repo (name the real frameworks/dirs you saw). Be honest: do not invent tools, credentials, or capabilities the member will not have.
- tools: capability tags that decide how this member can later be routed. Use ONLY these tags: "code" (may modify the repo) and "read" (may read the repo). An implementer/engineer gets ["code","read"]; a reviewer, lead, planner, or PM gets ["read"] or [] (text-only). Reserve "code" for true implementers — most members are text-only or read-only.${assignBlock}${castInstructions}

Return EXACTLY ONE JSON object as your entire reply — no prose, no code fence:
${jsonExample}`;
}

// Run ONE confined repo-scan turn and return a validated, capped proposal. The turn
// is read-only (SCAN_TOOLS) and bounded to the project root (cwd +
// allowedDirectories) — granting reads and confining them are one decision. Never
// throws: every failure mode (absent root, turn error, unparseable output) maps to
// an { ok:false, error } the caller surfaces.
export async function proposeCast(opts: ProposeCastOptions): Promise<ProposeCastResult> {
  const root = opts.project.rootPath.trim();
  // An empty root would confine to nothing — fail closed rather than scan unbounded.
  if (!root) {
    return { ok: false, error: `project "${opts.project.name}" has no root path to scan` };
  }
  const maxMembers = Math.max(1, opts.maxMembers ?? MAX_CAST_MEMBERS);
  const mission = opts.mission?.trim() || undefined;
  const availableProviders = assignableProviders(opts.providers ?? []);
  // Casting context is read ONCE, up front — a registry-load hiccup degrades to
  // "off" the same way castingOptions/loadRegistry already fail-soft elsewhere,
  // never blocking the scan itself.
  const castingCtx = castingOptions(
    await loadRegistry(opts.dataHome ?? ""),
    resolveThemingConfig(),
  );

  const outcome = await runScanTurn(
    opts.runAgentTurn,
    {
      system: SCAN_SYSTEM,
      prompt: scanPrompt(opts.project.name, mission, maxMembers, availableProviders, castingCtx),
      cwd: root,
      allowedDirectories: [root],
      allowedTools: [...SCAN_TOOLS],
    },
    opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    opts.abortSignal,
  );
  if (outcome.status !== "ok") {
    return {
      ok: false,
      error: `repo-scan turn ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
    };
  }

  const extracted = extractJson(outcome.text);
  const parsed = castProposalSchema.safeParse(extracted);
  if (!parsed.success) {
    return { ok: false, error: "repo-scan did not return a valid roster proposal" };
  }

  const notes: string[] = [];
  const normalized = parsed.data.members.map((m) => normalizeMember(m, opts.providers));
  for (const { note } of normalized) {
    if (note) notes.push(note);
  }
  let members = normalized.map((m) => m.member);
  if (members.length > maxMembers) {
    notes.push(`proposed ${members.length} members — capped to ${maxMembers}`);
    members = members.slice(0, maxMembers);
  }

  return {
    ok: true,
    proposal: {
      projectId: opts.project.id,
      projectName: opts.project.name,
      rootPath: root,
      ...(mission ? { mission } : {}),
      members,
      ...(parsed.data.summary?.trim() ? { summary: parsed.data.summary.trim() } : {}),
      notes,
      createdAt: new Date().toISOString(),
    },
  };
}

function normalizeMember(
  m: z.infer<typeof castMemberSchema>,
  providers: ProposeCastOptions["providers"],
): { member: CastProposalMember; note?: string } {
  const tools = m.tools
    ? [...new Set(m.tools.map((t) => t.trim()).filter((t) => t.length > 0))]
    : [];
  const toolAllowlist = normalizeToolAllowlist(m.toolAllowlist);
  const { pin, note } = validateProviderPin(m.name.trim(), m, providers);
  return {
    member: {
      name: m.name.trim(),
      role: m.role.trim(),
      charter: m.charter,
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolAllowlist ? { toolAllowlist } : {}),
      ...(pin.provider ? { provider: pin.provider } : {}),
      ...(pin.provider && pin.model ? { model: pin.model } : {}),
      ...(m.castAs ? { castAs: m.castAs } : {}),
    },
    ...(note ? { note } : {}),
  };
}

interface TurnOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
}

// Run the scan turn to its settled result, mirroring dispatch.ts's executeTurn:
// own a per-turn AbortController linked to the parent signal, drain the stream (the
// result is the source of truth), and race the result against the timeout — aborting
// the turn on timeout so a hung provider can't wedge the board action. Never throws.
async function runScanTurn(
  run: NonNullable<RibContext["runAgentTurn"]>,
  req: Omit<Parameters<NonNullable<RibContext["runAgentTurn"]>>[0], "abortSignal" | "timeoutMs">,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<TurnOutcome> {
  if (parentSignal?.aborted) return { status: "aborted", text: "" };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn: RibAgentTurn = run({ ...req, abortSignal: controller.signal, timeoutMs });
    // Wrap so neither branch rejects: a timed-out turn's still-pending drain must
    // not surface as an unhandled rejection once the race has settled.
    const settled = drainResult(turn).then(
      (result) => ({ kind: "result" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );
    const timed = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    const outcome = await Promise.race([settled, timed]);
    if (outcome.kind === "timeout") {
      return { status: "timeout", text: "", error: `repo-scan exceeded ${timeoutMs}ms` };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err) };
    }
    const result = outcome.result;
    if (controller.signal.aborted || result.status === "aborted") {
      return { status: "aborted", text: result.text ?? "" };
    }
    if (result.status === "ok") return { status: "ok", text: result.text };
    return {
      status: result.status,
      text: "",
      error: result.error ?? result.text ?? `turn ${result.status}`,
    };
  } catch (e) {
    return { status: "error", text: "", error: errText(e) };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// Drain the live stream to completion, then take the settled result (the source of
// truth). A stream error is swallowed — it resurfaces via result.status.
async function drainResult(turn: RibAgentTurn): Promise<RibAgentTurnResult> {
  try {
    for await (const _chunk of turn.stream) {
      // result is the source of truth; the stream is drained, not consumed
    }
  } catch {
    // a stream error surfaces via result.status below
  }
  return await turn.result;
}

// Pull the JSON object out of a model reply that may wrap it in a code fence or a
// sentence: prefer a fenced block, else the first `{` to the last `}`. Returns
// undefined when nothing parses, so the caller fails closed on malformed output.
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// --- proposal persistence -------------------------------------------------------
// The proposal lives as one file under the Squad data home so the (out-of-process)
// squad-cast collector and the (in-process) approve/discard handlers share one
// source of truth, the same split the roster collector and genesis use.

const CAST_PROPOSAL_FILE = "cast-proposal.json";

export async function writeProposal(dataHome: string, proposal: CastProposalRecord): Promise<void> {
  await mkdir(dataHome, { recursive: true });
  await writeFile(join(dataHome, CAST_PROPOSAL_FILE), `${JSON.stringify(proposal, null, 2)}\n`);
}

// Read the pending proposal back, or undefined when there is none / it is
// unreadable / it fails validation — so a corrupt file reads as "no proposal"
// rather than crashing the collector or the approve path.
export async function readProposal(dataHome: string): Promise<CastProposalRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dataHome, CAST_PROPOSAL_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CastProposalRecord>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (typeof parsed.projectName !== "string" || !Array.isArray(parsed.members)) return undefined;
    const members = parsed.members
      .filter(
        (m): m is CastProposalMember =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as CastProposalMember).name === "string" &&
          typeof (m as CastProposalMember).charter === "string",
      )
      .map((m, i) => normalizeStoredMember(m, i));
    if (members.length === 0) return undefined;
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      projectName: parsed.projectName,
      rootPath: typeof parsed.rootPath === "string" ? parsed.rootPath : "",
      ...(typeof parsed.mission === "string" && parsed.mission ? { mission: parsed.mission } : {}),
      members,
      ...(typeof parsed.summary === "string" && parsed.summary ? { summary: parsed.summary } : {}),
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.filter((n): n is string => typeof n === "string")
        : [],
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return undefined;
  }
}

function normalizeStoredMember(m: CastProposalMember, index: number): CastProposalMember {
  const toolAllowlist = normalizeToolAllowlist(m.toolAllowlist);
  return {
    ...(typeof m.slug === "string" && m.slug ? { slug: m.slug } : {}),
    name: m.name,
    role: typeof m.role === "string" && m.role ? m.role : "",
    charter: m.charter,
    ...(Array.isArray(m.tools) && m.tools.length > 0
      ? { tools: m.tools.filter((t): t is string => typeof t === "string") }
      : {}),
    ...(toolAllowlist ? { toolAllowlist } : {}),
    ...(typeof m.provider === "string" && m.provider ? { provider: m.provider } : {}),
    ...(typeof m.provider === "string" && m.provider && typeof m.model === "string" && m.model
      ? { model: m.model }
      : {}),
    ...(typeof m.themeId === "string" && m.themeId ? { themeId: m.themeId } : {}),
    ...(typeof m.themeLabel === "string" && m.themeLabel ? { themeLabel: m.themeLabel } : {}),
    ...(typeof m.personality === "string" && m.personality ? { personality: m.personality } : {}),
    ...(typeof m.backstory === "string" && m.backstory ? { backstory: m.backstory } : {}),
    ...(typeof m.originalName === "string" && m.originalName
      ? { originalName: m.originalName }
      : {}),
    identitySlot: normalizeIdentitySlot(m.identitySlot, index),
  };
}

export async function clearProposal(dataHome: string): Promise<void> {
  await rm(join(dataHome, CAST_PROPOSAL_FILE), { force: true });
}

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CanvasBoardView,
  Project,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  SnapshotManager,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { asNonEmptyString, DEFAULT_PROJECT_NAME, errText, expectView, z } from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { APPROVE_CAST_ACTION, CAST_PROPOSE_ACTION, DISCARD_CAST_ACTION } from "./boards/cast.ts";
import { buildRunDetailBoard, COORDINATE_ACTION, DISPATCH_ACTION } from "./boards/coordinator.ts";
import { buildDecisionsBoard, RECORD_DECISION_ACTION } from "./boards/decisions.ts";
import { ASSIGN_CODE_ACTION, RETIRE_ALL_ACTION, SELECT_PROJECT_ACTION } from "./boards/roster.ts";
import { VIEW_RUN_ACTION } from "./boards/runs.ts";
import type { CastProposalMember, CastProposalRecord } from "./cast.ts";
import { clearProposal, proposeCast, readProposal, writeProposal } from "./cast.ts";
import {
  assignThemedIdentity,
  foldThemedCharter,
  retireCastingName,
  themeLabel,
} from "./casting/registry.ts";
import { memberCanCode, runCodeTurn } from "./code.ts";
import { buildSeedFor } from "./compose.ts";
import { type RunCoordinatorResult, runCoordinator } from "./coordinator.ts";
import { captureDiffUnderReview, type DispatchOutcome, dispatchFanout } from "./dispatch.ts";
import { slugify } from "./genesis.ts";
import {
  CAST_KEY,
  COORDINATOR_KEY,
  DECISIONS_KEY,
  ROSTER_KEY,
  RUN_DETAIL_KEY,
  SQUAD_RUNS_KEY,
  SQUAD_SURFACE_ID,
} from "./keys.ts";
import {
  appendLog,
  type MemberRecord,
  readMembers,
  retireMember,
  scaffoldMember,
  scaffoldRoster,
  setMemberModel,
  writeMemory,
} from "./member-store.ts";
import { openChangeRequest } from "./open-change-request.ts";
import { DEFAULT_LIMITS } from "./orchestrator.ts";
import {
  DEFAULT_SCOPE_ID,
  isSquadDataHomeWritable,
  scopeDataHome,
  scopeMembersDir,
  setSquadDataHome,
  squadDataHome,
} from "./paths.ts";
import { squadPolicies } from "./policies.ts";
import { validateProviderPin } from "./provider-pins.ts";
import { listRuns, loadRun, type RunSummary } from "./runs-store.ts";
import {
  readSelectedProject,
  listScopeMembersDirs,
  type SelectedProject,
  selectedScopeId,
  writeProjectsSnapshot,
  writeSelectedProject,
} from "./scope.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import type { TurnOutcome } from "./turn-runner.ts";
import { identitySlotForIndex, identityTonesByMember, type Member } from "./types.ts";

// Seams captured in registerTools (the only hook with the full ctx) and cleared in
// dispose. refreshWorkflow re-runs a bound collector (squad-roster, squad-cast)
// after a mutation so the panel updates promptly instead of waiting on cadence;
// runAgentTurn backs squad_dispatch (the fan-out coordinator) and the cast-propose
// repo-scan; getProjects resolves the project a cast scan is confined to.
let refreshWorkflow: RibContext["refreshWorkflow"];
let runAgentTurn: RibContext["runAgentTurn"];
let getProjects: RibContext["getProjects"];
let getProviders: RibContext["getProviders"];
// The run-detail drill-down: an imperatively-registered snapshot whose composer reads
// the board the last View action selected. Cleared (and unregistered) in dispose.
let snapshots: SnapshotManager | undefined;
let unregisterRunDetail: (() => void) | undefined;
let runDetailBoard: CanvasBoardView | undefined;

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));
// The cast collector: renders the pending cast-proposal.json as the Proposed-squad
// board. Resolved at module load like ROSTER_COLLECTOR so the squad-cast bash node
// runs the right file regardless of the run's cwd; shell-quoted where interpolated.
const CAST_COLLECTOR = fileURLToPath(new URL("../bin/collect-cast.ts", import.meta.url));
// The coordinator collector: renders the persisted coordinator-ledger.json as the Run-loop
// board. Resolved at module load like the others so the squad-coordinator bash node runs the
// right file regardless of the run's cwd; shell-quoted where interpolated.
const COORDINATOR_COLLECTOR = fileURLToPath(
  new URL("../bin/collect-coordinator.ts", import.meta.url),
);
// The runs collector: renders the archived coordinator run ledgers under the selected
// scope as the Runs history board. Resolved at module load like the others so the
// squad-runs bash node runs the right file regardless of cwd; shell-quoted below.
const RUNS_COLLECTOR = fileURLToPath(new URL("../bin/collect-runs.ts", import.meta.url));

// POSIX single-quote: wrap a value and escape any embedded quote so a path
// (spaces, `$`, backticks, backslashes) reaches `bash -c` literally — never
// word-split or expanded.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Refresh the on-disk project catalog the roster picker renders from. Best-effort
// and fire-and-forget: the collector reads projects.json, so a project added in
// core surfaces on the next interaction, one action stale at worst.
function snapshotProjects(): void {
  try {
    const projects = (getProjects?.() ?? []).map((p) => ({ id: p.id, name: p.name }));
    void writeProjectsSnapshot(squadDataHome(), projects).catch(() => {});
  } catch {
    // a throwing projects seam must not break boot or an action dispatch
  }
}

// Genesis as a workflow: one agent turn reads a freeform brief, authors the
// charter, and persists the member by calling the squad_emit_member tool (the
// deterministic write seam). It publishes no snapshot — its product is files on
// disk, which the squad-roster collector then reflects. The board's author
// actions pass the brief as $inputs.brief; a CLI `/workflow run squad-genesis
// <brief>` passes it as $ARGUMENTS, so the prompt reads both. The model is scoped
// to the one emit tool (rib tools are default-off in workflow prompt nodes).
const GENESIS_WF_PROMPT = `You are authoring the founding identity of a new persistent agent — a "member" of a Keelson Squad, a team of agents an operator talks to directly.

Brief: $inputs.brief $ARGUMENTS

From the brief, decide the member's name, a short role title (1-4 words — e.g. "Tech Lead", "Backend Engineer" — a label for a roster pill, NOT a sentence), and write an honest founding charter. Do NOT invent tools, credentials, or capabilities it does not have; describe who it is, what it is for, and how it works.

Compose:
- charter: Markdown for the member's charter.md, with these sections in order:
    # <name>
    ## Role     — who this member is, grounded in the role title
    ## Mission  — what it exists to do
    ## Voice    — how it speaks (tone, length, habits)

Then call the squad_emit_member tool EXACTLY ONCE with { name, role, charter } to persist the member — do NOT print the JSON as your reply. After the tool returns, reply with EXACTLY one line: "Authored <name> (<slug>)", using the name you authored and the tool-returned slug verbatim.`;

// The exact board shape the squad-decisions prompt must emit, generated from the
// pure builder so the worked example can't drift from buildDecisionsBoard (the
// tested contract). One representative decision; the live turn re-shapes the
// recalled rows into the same structure.
const DECISIONS_BOARD_EXAMPLE = JSON.stringify(
  buildDecisionsBoard([
    {
      summary: "Adopt trunk-based development",
      type: "decision",
      content: "Merge small PRs to main daily rather than maintain long-lived feature branches.",
      provenance: "generated",
      createdAt: "2026-06-20T00:00:00.000Z",
    },
  ]),
);

// The squad-decisions render turn: the node's `memory: { recall }` block runs first
// and substitutes the recalled decision/lesson rows into $memory.recall.items; this
// prompt turns them into the decisions board. The model authors the board to match
// the buildDecisionsBoard contract above (output_schema only checks view+sections;
// expectView re-validates at the binding edge). Deterministic, action-guaranteed
// rendering would need a tool+publish or bash-collector producer — a later refinement.
const DECISIONS_WF_PROMPT = `You render the squad's governed decision ledger as a Keelson canvas board.

Recalled decisions and lessons (a JSON array; empty if none recorded): $memory.recall.items

Each item carries: { memoryId, type, summary, content, provenance, scope, createdAt, rankingScore }.

Emit EXACTLY ONE canvas board object as your entire reply — no prose, no code fence. Match this shape exactly:
${DECISIONS_BOARD_EXAMPLE}

Rules:
- One card per recalled item, most relevant first (highest rankingScore). Card title = the item's summary; pill.label = its type; add fields for provenance and the recorded date (createdAt's calendar date, YYYY-MM-DD); put a short excerpt of content on the card's reason line (label "context").
- If the array is empty, return a board whose only content section is one rows item explaining no decisions are recorded yet.
- ALWAYS include the final "Record a decision" actions section exactly as shown, so the operator can always add one.
- Set header.status.label to the decision count (e.g. "3 decisions", "1 decision", "0 decisions").`;

// The surface-launched assign-work workflows are thin, deterministic wrappers: one
// prompt turn whose only job is to call the matching squad tool exactly once, so the
// verb becomes an inspectable workflow run (and, for coordinate, streams into the
// promoted Run-loop panel). The tools do the real work; the model must not.
const COORDINATE_WF_PROMPT = `The operator has handed the squad a task to run its coordinator on:

$inputs.task

Call the squad_coordinate tool EXACTLY ONCE, passing that text as \`task\` and \`maxRounds\`: 6 (a bounded surface run). Do NOT attempt the work yourself — the tool runs the whole plan→delegate→observe loop against the selected project and returns a summary. After it returns, reply with EXACTLY its summary text.`;

const DISPATCH_WF_PROMPT = `The operator wants the whole squad to weigh in on one question:

$inputs.task

Call the squad_dispatch tool EXACTLY ONCE, passing that text as \`task\` (leave \`members\` unset to fan out to every active member; leave \`synthesize\` at its default). Do NOT answer it yourself — the tool fans the question out and synthesizes the replies. After it returns, reply with EXACTLY its synthesized answer.`;

const CODE_WF_PROMPT = `The operator has assigned a coding task to one specific squad member:

Member slug: $inputs.member
Task:
$inputs.task

Call the squad_code tool EXACTLY ONCE with \`member\` set to that slug and \`task\` set to the task above. Do NOT write any code yourself — the tool runs a confined coding turn as that member against the selected project. After it returns, reply with EXACTLY its result.`;

const CAST_SCAN_WF_PROMPT = `The operator wants to auto-compose a squad for the selected project by scanning its repository.

Mission (optional focus): $inputs.mission

Call the squad_propose_cast tool EXACTLY ONCE. If the mission above is non-empty, pass it as \`mission\`; otherwise omit it. Do NOT inspect the repository yourself — the tool runs a confined read-only scan and proposes the team into the Proposed squad panel. After it returns, reply with EXACTLY its summary.`;

// Tool results stream to chat as `tool_result` chunks; keep each well under the
// chat context budget. Truncation is signalled, never silent.
const MAX_TOOL_RESULT_CHARS = 16_000;
function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars)`;
}
function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({
    type: "tool_result",
    toolUseId: "",
    content: boundedText(content),
    ...(isError ? { isError: true } : {}),
  });
}

// The single themed-casting intercept (#16): turn a proposed { name, role } into the
// persisted member record. assignThemedIdentity replaces the proposed name with a
// best-fit ensemble character (deterministic, registry-backed) and the character's
// voice is folded into the charter so compose.ts carries it. Both genesis
// (squad_emit_member) and auto-cast (the approve/scaffold path) build their records
// through here, so the two theme with one code path. Theming off / exhausted keeps
// the proposed name (assignThemedIdentity returns no themeId).
async function themedRecord(
  dataHome: string,
  base: {
    name: string;
    role: string;
    charter: string;
    createdAt: string;
    model?: string;
    provider?: string;
    tools?: readonly string[];
  },
  identitySlot: number,
): Promise<MemberRecord> {
  const id = await assignThemedIdentity(dataHome, {
    proposedName: base.name,
    role: base.role,
  });
  return {
    slug: id.slug,
    name: id.name,
    role: base.role,
    charter: foldedCharter(base.charter, id),
    status: "active",
    createdAt: base.createdAt,
    identitySlot: identitySlotForIndex(identitySlot),
    ...(id.themeId ? { themeId: id.themeId } : {}),
    ...(id.personality ? { personality: id.personality } : {}),
    ...(id.backstory ? { backstory: id.backstory } : {}),
    ...(id.originalName !== id.name ? { originalName: id.originalName } : {}),
    ...(base.provider ? { provider: base.provider } : {}),
    ...(base.provider && base.model ? { model: base.model } : {}),
    ...(base.tools && base.tools.length > 0 ? { tools: [...base.tools] } : {}),
  };
}

function foldedCharter(
  charter: string,
  id: {
    name: string;
    themeId?: string;
    personality?: string;
    backstory?: string;
  },
): string {
  return id.themeId && id.personality
    ? foldThemedCharter(charter, {
        name: id.name,
        personality: id.personality,
        backstory: id.backstory ?? "",
        themeLabel: themeLabel(id.themeId) ?? id.themeId,
      })
    : charter;
}

async function themedProposal(
  dataHome: string,
  proposal: CastProposalRecord,
): Promise<CastProposalRecord> {
  const members: CastProposalMember[] = [];
  const renames: [from: string, to: string][] = [];
  for (let i = 0; i < proposal.members.length; i++) {
    const m = proposal.members[i]!;
    const id = await assignThemedIdentity(dataHome, {
      proposedName: m.name,
      role: m.role,
    });
    if (id.originalName !== id.name) renames.push([id.originalName, id.name]);
    members.push({
      slug: id.slug,
      name: id.name,
      role: m.role,
      charter: foldedCharter(m.charter, id),
      ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.provider && m.model ? { model: m.model } : {}),
      ...(id.themeId ? { themeId: id.themeId } : {}),
      ...(id.personality ? { personality: id.personality } : {}),
      ...(id.backstory ? { backstory: id.backstory } : {}),
      originalName: id.originalName,
      identitySlot: identitySlotForIndex(i),
    });
  }
  // Notes minted before theming (e.g. a dropped provider pin) name the scan's
  // working members; the panel only ever shows themed names, so speak those.
  let notes = proposal.notes;
  for (const [from, to] of renames) {
    const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    notes = notes.map((n) => n.replace(pattern, () => to));
  }
  return { ...proposal, members, notes };
}

async function retireProposalNames(dataHome: string, proposal: CastProposalRecord): Promise<void> {
  for (const m of proposal.members) {
    if (m.slug && m.themeId) await retireCastingName(dataHome, m.slug);
  }
}

// The genesis write seam: the squad-genesis workflow's prompt node authors the
// charter and calls this tool to persist the member. Deterministic and in-process
// (it reuses scaffoldMember), so the generative half stays in the prompt and the
// write half stays testable. Capability `tools` are free-form in Phase 0 — deduped
// and trimmed, never vocabulary-checked.
const memberEmitSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  charter: z.string().min(1),
  model: z.string().optional(),
  project: z.string().optional(),
  provider: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

function makeEmitMemberTool(
  refresh?: RibContext["refreshWorkflow"],
  projectsSeam?: RibContext["getProjects"],
): ToolDefinition {
  return {
    name: "squad_emit_member",
    description:
      "Internal write-seam for the squad-genesis workflow: persist an authored member (charter.md + record) under members/<slug>. The workflow's prompt turn authors { name, role, charter, optional model/provider pin, optional capability tools }; this tool only writes, failing closed on a slug collision. To create a member, run the squad-genesis workflow (e.g. /workflow run squad-genesis <brief>) rather than calling this directly.",
    inputSchema: memberEmitSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = memberEmitSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_emit_member: ${parsed.error.message}`, true);
        return;
      }
      const { name, role, charter, tools, model: rawModel, provider: rawProvider } = parsed.data;
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_emit_member: ${resolution.error}`, true);
          return;
        }
        const { scopeId } = resolution;
        let providers: ReturnType<NonNullable<RibContext["getProviders"]>> | undefined;
        if (getProviders) {
          try {
            providers = getProviders();
          } catch {
            providers = [];
          }
        }
        const validated = validateProviderPin(
          name,
          { provider: rawProvider, model: rawModel },
          providers,
        );
        const dedupedTools = tools
          ? [...new Set(tools.map((t) => t.trim()).filter((t) => t.length > 0))]
          : [];
        // An authored member takes the next slot after the existing roster, so
        // hand-built teams don't stack every member on slot 0.
        const existing = await readMembers(scopeMembersDir(home, scopeId));
        const record = await themedRecord(
          scopeDataHome(home, scopeId),
          {
            name,
            role,
            charter,
            createdAt: new Date().toISOString(),
            ...(validated.pin.provider ? { provider: validated.pin.provider } : {}),
            ...(validated.pin.provider && validated.pin.model
              ? { model: validated.pin.model }
              : {}),
            ...(dedupedTools.length > 0 ? { tools: dedupedTools } : {}),
          },
          existing.length,
        );
        await scaffoldMember(scopeMembersDir(home, scopeId), record);
        // Re-run the bound squad-roster collector so the new member appears
        // promptly instead of waiting on cadence. Fail-soft (the seam resolves on
        // error and is absent on an older harness) — never throw.
        await refresh?.("squad-roster");
        emitResult(
          ctx,
          JSON.stringify({
            ok: true,
            slug: record.slug,
            name: record.name,
            ...(validated.note ? { note: validated.note } : {}),
          }),
        );
      } catch (e) {
        emitResult(ctx, `squad_emit_member failed: ${errText(e)}`, true);
      }
    },
  };
}

const memberListSchema = z.object({ project: z.string().optional() });

function makeListMembersTool(projectsSeam?: RibContext["getProjects"]): ToolDefinition {
  return {
    name: "squad_list_members",
    description:
      "List the squad's members (the roster): each member's slug, name, role, charter, status, and any pinned model/provider and capability tools. Read-only. NOT for creating a member (run the squad-genesis workflow) or retiring one (squad_retire_member).",
    inputSchema: memberListSchema,
    async execute(input, ctx) {
      const parsed = memberListSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_list_members: ${parsed.error.message}`, true);
        return;
      }
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_list_members: ${resolution.error}`, true);
          return;
        }
        const { scopeId } = resolution;
        const members = await readMembers(scopeMembersDir(home, scopeId));
        emitResult(ctx, JSON.stringify({ members }));
      } catch (e) {
        emitResult(ctx, `squad_list_members failed: ${errText(e)}`, true);
      }
    },
  };
}

const memberRetireSchema = z.object({ project: z.string().optional(), slug: z.string().min(1) });

function makeRetireMemberTool(
  refresh?: RibContext["refreshWorkflow"],
  projectsSeam?: RibContext["getProjects"],
): ToolDefinition {
  return {
    name: "squad_retire_member",
    description:
      "Retire a member: permanently remove a member's record and charter.md from the roster. `slug` is the member's identifier (see squad_list_members). Fails closed if no such member exists.",
    inputSchema: memberRetireSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = memberRetireSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_retire_member: ${parsed.error.message}`, true);
        return;
      }
      let scopedHome: string | undefined;
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_retire_member: ${resolution.error}`, true);
          return;
        }
        const { scopeId } = resolution;
        scopedHome = scopeDataHome(home, scopeId);
        await retireMember(scopeMembersDir(home, scopeId), parsed.data.slug);
        // Free the cast name so the ensemble can reuse it (fail-soft, never throws).
        await retireCastingName(scopedHome, parsed.data.slug);
        await refresh?.("squad-roster");
        emitResult(ctx, JSON.stringify({ ok: true, slug: parsed.data.slug }));
      } catch (e) {
        // retireMember throws when the dir is already gone — but a registry entry can
        // linger with no dir (a phantom reservation from a failed scaffold). Free it
        // here too, or that character name is consumed forever.
        if (scopedHome) await retireCastingName(scopedHome, parsed.data.slug);
        emitResult(ctx, `squad_retire_member failed: ${errText(e)}`, true);
      }
    },
  };
}

// Record a learning into a member's PRIVATE per-agent memory (the rib data dir —
// the governed ledger has no per-agent scope). `target: "log"` (default) appends a
// timestamped bullet to log.md, the accumulating journal; `target: "memory"`
// overwrites memory.md with `text` as the whole consolidated durable doc (the same
// seam reflection uses). Fail-closed on an unsafe slug / missing member / over-cap.
const rememberSchema = z.object({
  slug: z.string().min(1),
  text: z.string().min(1),
  target: z.enum(["log", "memory"]).optional(),
});

function makeRememberTool(): ToolDefinition {
  return {
    name: "squad_remember",
    description:
      'Record a learning into a squad member\'s private memory. `slug` is the member (see squad_list_members); `text` is the learning. `target` selects where: "log" (default) appends one timestamped line to the member\'s running journal; "memory" overwrites the member\'s durable memory doc with `text` as the whole consolidated document. Fails closed on an unknown member or over-cap text. NOT for the shared decision ledger (run squad-decide) or for authoring a member (squad-genesis).',
    inputSchema: rememberSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = rememberSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_remember: ${parsed.error.message}`, true);
        return;
      }
      const { slug, text, target = "log" } = parsed.data;
      try {
        const home = squadDataHome();
        const scopeId = selectedScopeId(await readSelectedProject(home));
        const membersRoot = scopeMembersDir(home, scopeId);
        if (target === "memory") {
          await writeMemory(membersRoot, slug, text);
        } else {
          await appendLog(membersRoot, slug, text, new Date().toISOString());
        }
        emitResult(ctx, JSON.stringify({ ok: true, slug, target }));
      } catch (e) {
        emitResult(ctx, `squad_remember failed: ${errText(e)}`, true);
      }
    },
  };
}

// The fan-out coordinator as a tool: dispatch ONE task to several members in
// parallel, then synthesize their replies into one answer. Dispatched turns are
// text-only (no Bash/Edit/Write, no cwd) — the spike proves the shape safely.
// Fails closed when the agent-turn seam is absent (an older harness). Cost is one
// billed turn per dispatched member + one synthesis turn.
const dispatchSchema = z.object({
  task: z.string().min(1),
  members: z.array(z.string()).optional(),
  synthesize: z.boolean().optional(),
});

function makeDispatchTool(turnSeam: RibContext["runAgentTurn"]): ToolDefinition {
  return {
    name: "squad_dispatch",
    description:
      "Fan a single task out to multiple squad members at once — each answers independently and in parallel — then synthesize their replies into one coherent answer. `task` is the shared brief; `members` (optional slugs) selects who runs (default: all active members); `synthesize` (default true) adds a final synthesis turn. Read-only/text-only per member. NOT for 1:1 chat (enter a member) or authoring/retiring members.",
    inputSchema: dispatchSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = dispatchSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_dispatch: ${parsed.error.message}`, true);
        return;
      }
      if (!turnSeam) {
        emitResult(ctx, "squad_dispatch: agent-turn seam unavailable on this harness", true);
        return;
      }
      try {
        const { task, members: requested, synthesize } = parsed.data;
        const home = squadDataHome();
        const scopeId = selectedScopeId(await readSelectedProject(home));
        const membersRoot = scopeMembersDir(home, scopeId);
        const active = (await readMembers(membersRoot)).filter((m) => m.status === "active");
        const wanted = requested && requested.length > 0 ? new Set(requested) : undefined;
        const members = wanted ? active.filter((m) => wanted.has(m.slug)) : active;
        if (members.length === 0) {
          emitResult(ctx, "squad_dispatch: no matching active members to dispatch to", true);
          return;
        }
        const outcome = await dispatchFanout({
          runAgentTurn: turnSeam,
          membersRoot,
          members,
          task,
          abortSignal: ctx.abortSignal,
          ...(synthesize !== undefined ? { synthesize } : {}),
        });
        emitResult(ctx, summarizeDispatch(outcome));
      } catch (e) {
        emitResult(ctx, `squad_dispatch failed: ${errText(e)}`, true);
      }
    },
  };
}

// Per-member excerpt cap inside the summary so one long reply can't crowd out the
// others before emitResult's overall bound applies.
const DISPATCH_MEMBER_EXCERPT = 1200;

function summarizeDispatch(outcome: DispatchOutcome): string {
  const lines: string[] = [`Task: ${outcome.task}`, "", `Members (${outcome.perMember.length}):`];
  for (const r of outcome.perMember) {
    const body =
      r.status === "ok" ? r.text.trim().slice(0, DISPATCH_MEMBER_EXCERPT) : (r.error ?? r.status);
    lines.push(`- ${r.name} (${r.slug}) — ${r.status}: ${body}`);
  }
  lines.push("", "Synthesis:", outcome.synthesis?.trim() || "(none)");
  if (outcome.notes.length > 0) {
    lines.push("", "Notes:", ...outcome.notes.map((n) => `- ${n}`));
  }
  return lines.join("\n");
}

async function activeMemberScopeLocations(home: string): Promise<string | undefined> {
  try {
    const summaries: string[] = [];
    for (const membersRoot of await listScopeMembersDirs(home)) {
      const activeCount = (await readMembers(membersRoot)).filter((m) => m.status === "active").length;
      if (activeCount === 0) continue;
      const scope =
        membersRoot === scopeMembersDir(home, DEFAULT_SCOPE_ID) ? DEFAULT_SCOPE_ID : basename(dirname(membersRoot));
      summaries.push(`${scope} (${activeCount})`);
    }
    return summaries.length > 0 ? summaries.join(", ") : undefined;
  } catch {
    return undefined;
  }
}

// Code mode as a tool: dispatch a confined coding turn to a code-capable member that
// actually edits the selected project's repo (write rail, bounded to the project
// root). The RAI floor (contributePolicies) hard-denies merging/force-pushing from
// the turn, so the squad does the work without owning integration. Fails closed
// without the agent-turn / projects seams, or on an unknown / inactive / non-code
// member, or an unresolved project — granting write tools is the thing to refuse on
// any doubt.
const codeSchema = z.object({
  member: z.string().min(1),
  task: z.string().min(1),
  project: z.string().optional(),
});

function makeCodeTool(
  turnSeam: RibContext["runAgentTurn"],
  projectsSeam: RibContext["getProjects"],
): ToolDefinition {
  return {
    name: "squad_code",
    description:
      "Dispatch a confined coding turn to a code-capable squad member: it edits the selected project's repository directly (Read/Glob/Grep/Edit/Write/Bash, confined to the project root) to implement `task`. `member` is the slug of a member carrying the \"code\" capability tag (see squad_list_members); `task` is what to implement; `project` (optional id or name) selects the repo, defaulting to the sole / `default` project. The turn may NOT merge or force-push — the squad's RAI floor denies it; opening a draft PR and ordinary pushes are allowed (the human review gate owns the merge). NOT for text-only reasoning (squad_dispatch) or 1:1 chat (enter a member).",
    inputSchema: codeSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = codeSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_code: ${parsed.error.message}`, true);
        return;
      }
      if (!turnSeam) {
        emitResult(ctx, "squad_code: agent-turn seam unavailable on this harness", true);
        return;
      }
      if (!projectsSeam) {
        emitResult(ctx, "squad_code: projects seam unavailable on this harness", true);
        return;
      }
      const { member: slug, task } = parsed.data;
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        // The SAME resolution squad_coordinate uses, so a selected team is the team that
        // codes: an explicit arg binds that repo + scope; a selection binds its scope and
        // (when live) its repo; a stale selection keeps the scope but degrades to no repo.
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_code: ${resolution.error}`, true);
          return;
        }
        const { scopeId, project: boundProject } = resolution;
        const membersRoot = scopeMembersDir(home, scopeId);
        const member = (await readMembers(membersRoot)).find((m) => m.slug === slug);
        if (!member) {
          const locations = await activeMemberScopeLocations(home);
          emitResult(
            ctx,
            `squad_code: unknown member "${slug}" in scope "${scopeId}"${locations ? `; active members live in: ${locations}` : ""}`,
            true,
          );
          return;
        }
        if (member.status !== "active") {
          emitResult(ctx, `squad_code: member "${slug}" is not active in scope "${scopeId}"`, true);
          return;
        }
        if (!memberCanCode(member)) {
          emitResult(
            ctx,
            `squad_code: member "${slug}" lacks the "code" capability — only code-tagged members may modify the repo`,
            true,
          );
          return;
        }
        // squad_code MUST have a repo to edit. A stale selection degrades here (scope was
        // still resolved, so the member lookup above held) instead of hard-erroring earlier.
        if (!boundProject) {
          emitResult(
            ctx,
            "squad_code: no project bound to code against — the selected project no longer exists or none is selected; re-select a project",
            true,
          );
          return;
        }
        const result = await runCodeTurn({
          runAgentTurn: turnSeam,
          membersRoot,
          member,
          project: { name: boundProject.name, rootPath: boundProject.rootPath },
          task,
          abortSignal: ctx.abortSignal,
        });
        if (!result.ok) {
          emitResult(ctx, `squad_code: ${result.error}`, true);
          return;
        }
        emitResult(
          ctx,
          summarizeCode(member, boundProject.name, result.outcome),
          result.outcome.status !== "ok",
        );
      } catch (e) {
        emitResult(ctx, `squad_code failed: ${errText(e)}`, true);
      }
    },
  };
}

function summarizeCode(member: Member, projectName: string, outcome: TurnOutcome): string {
  const head = `Code turn — ${member.name} (${member.slug}) on "${projectName}" — ${outcome.status}`;
  const body =
    outcome.status === "ok"
      ? outcome.text.trim() || "(no output)"
      : (outcome.error ?? outcome.status);
  return `${head}\n\n${body}`;
}

const openPrSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  project: z.string().optional(),
});

function makeOpenPrTool(
  projectsSeam: RibContext["getProjects"],
  execSeam: RibContext["getExec"],
): ToolDefinition {
  return {
    name: "squad_open_pr",
    description:
      "Open an operator-requested DRAFT change request for the selected project: creates a feature branch at HEAD from `title`, pushes it without force to the selected/upstream remote, then uses the detected forge CLI (GitHub `gh` or GitLab `glab`) to open a draft PR/MR with `body`. `project` (optional id/name) overrides the selected project. Never merges, rebases, resets, force-pushes, or runs automatically at the done-gate.",
    inputSchema: openPrSchema,
    state_changing: true,
    requires_confirmation: true,
    async execute(input, ctx) {
      const parsed = openPrSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_open_pr: ${parsed.error.message}`, true);
        return;
      }
      if (!execSeam) {
        emitResult(ctx, "squad_open_pr: exec seam unavailable on this harness", true);
        return;
      }
      if (!projectsSeam) {
        emitResult(ctx, "squad_open_pr: projects seam unavailable on this harness", true);
        return;
      }
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_open_pr: ${resolution.error}`, true);
          return;
        }
        if (!resolution.project) {
          emitResult(
            ctx,
            "squad_open_pr: no project bound to open a change request for — select a project first",
            true,
          );
          return;
        }
        const result = await openChangeRequest({
          exec: execSeam(),
          cwd: resolution.project.rootPath,
          title: parsed.data.title,
          body: parsed.data.body,
        });
        if (!result.ok) {
          emitResult(ctx, `squad_open_pr: ${result.error}`, true);
          return;
        }
        emitResult(ctx, result.url, false);
      } catch (e) {
        emitResult(ctx, `squad_open_pr failed: ${errText(e)}`, true);
      }
    },
  };
}

const viewDiffSchema = z.object({ project: z.string().optional() });

function makeViewDiffTool(
  projectsSeam: RibContext["getProjects"],
  execSeam: RibContext["getExec"],
): ToolDefinition {
  return {
    name: "squad_view_diff",
    description:
      "Show the selected project's staged, unstaged, and untracked git diff using the same bounded capture as the review gate. `project` (optional id/name) overrides the selected project. Read-only: runs only git diff/status-style commands and never mutates the working tree.",
    inputSchema: viewDiffSchema,
    async execute(input, ctx) {
      const parsed = viewDiffSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_view_diff: ${parsed.error.message}`, true);
        return;
      }
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_view_diff: ${resolution.error}`, true);
          return;
        }
        if (!resolution.project) {
          emitResult(
            ctx,
            "squad_view_diff: no project bound to view a diff for — select a project first",
            true,
          );
          return;
        }
        if (!execSeam) {
          emitResult(ctx, "squad_view_diff: exec seam unavailable on this harness", true);
          return;
        }
        const diff = (
          await captureDiffUnderReview(
            "view the project diff",
            { name: resolution.project.name, rootPath: resolution.project.rootPath },
            true,
            execSeam(),
          )
        )?.trim();
        if (
          !diff ||
          diff ===
            "_No staged, unstaged, or untracked changes detected in the project working tree._"
        ) {
          emitResult(ctx, `no changes in ${resolution.project.name}`);
          return;
        }
        if (diff.startsWith("_Diff capture unavailable:")) {
          emitResult(ctx, `squad_view_diff: ${diff}`, true);
          return;
        }
        emitResult(ctx, `Diff — ${resolution.project.name}\n\n${diff}`);
      } catch (e) {
        emitResult(ctx, `squad_view_diff: ${errText(e)}`, true);
      }
    },
  };
}

// The standing Magentic coordinator as a tool: run the plan→delegate→observe→re-plan
// loop on a task. Each round is one coordinator turn that picks the next step and
// dispatches it to the best-suited member; the durable ledger lets a restart resume.
// Fails closed without the agent-turn seam, on an unknown project selector, or with no
// active members to coordinate.
const coordinateSchema = z.object({
  task: z.string().min(1),
  project: z.string().optional(),
  members: z.array(z.string()).optional(),
  managerModel: z.string().optional(),
  managerProvider: z.string().optional(),
  // maxRounds bounds above DEFAULT_LIMITS.maxRounds (24) so the default is a valid explicit
  // value; maxStall/maxResets (defaults 3/2) stay tight — they exist to cut a run SHORT.
  maxRounds: z.number().int().min(1).max(100).optional(),
  maxStall: z.number().int().min(1).max(20).optional(),
  maxResets: z.number().int().min(1).max(20).optional(),
  // Operator-supplied verification commands run at the done-gate (each via `bash -c` in the
  // project root); a red exit vetoes `done`. Omit to auto-detect package.json check/typecheck/test.
  verify: z.array(z.string().min(1).max(300)).max(8).optional(),
});

function makeCoordinateTool(
  turnSeam: RibContext["runAgentTurn"],
  projectsSeam: RibContext["getProjects"],
  runWorkflowSeam: RibContext["runWorkflow"],
  memorySeam: RibContext["getMemory"],
  execSeam: RibContext["getExec"],
): ToolDefinition {
  return {
    name: "squad_coordinate",
    description:
      "Run the squad's Magentic coordinator on a task: a standing manager turn plans, delegates one step at a time to the best-suited member, tracks progress in a durable ledger, and stops when the goal is met or it gives up. Each step is a text dispatch, a confined coding turn that edits the repo (when `project` is set and the member is code-capable), or authoring a reusable workflow DAG (persisted as an artifact for the operator to run). `task` is the goal; `members` (optional slugs) limits the team (default: all active); `project` (optional id/name) confines code steps to that repo (omit for a reasoning-only run); `maxRounds` (1–100), `maxStall`, and `maxResets` (each 1–20) cap the loop. Returns the final summary + a round-by-round trace. NOT for a single one-off question (squad_dispatch) or a single direct code edit (squad_code).",
    inputSchema: coordinateSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = coordinateSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_coordinate: ${parsed.error.message}`, true);
        return;
      }
      if (!turnSeam) {
        emitResult(ctx, "squad_coordinate: agent-turn seam unavailable on this harness", true);
        return;
      }
      const {
        task,
        members: requested,
        managerModel,
        managerProvider,
        maxRounds,
        maxStall,
        maxResets,
        verify: verifyInput,
      } = parsed.data;
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        if (!resolution.ok) {
          emitResult(ctx, `squad_coordinate: ${resolution.error}`, true);
          return;
        }
        const { scopeId } = resolution;
        const project = resolution.project
          ? {
              id: resolution.project.id,
              name: resolution.project.name,
              rootPath: resolution.project.rootPath,
            }
          : undefined;
        const membersRoot = scopeMembersDir(home, scopeId);
        const active = (await readMembers(membersRoot)).filter((m) => m.status === "active");
        const wanted = requested && requested.length > 0 ? new Set(requested) : undefined;
        const roster = wanted ? active.filter((m) => wanted.has(m.slug)) : active;
        if (roster.length === 0) {
          const locations = await activeMemberScopeLocations(home);
          emitResult(
            ctx,
            `squad_coordinate: no matching active members to coordinate in scope "${scopeId}"${locations ? `; active members live in: ${locations}` : ""}`,
            true,
          );
          return;
        }
        // Resolve the done-gate verify commands: the operator's explicit list wins; otherwise
        // auto-detect package.json check/typecheck/test in the bound project (fail open if none).
        const verify =
          verifyInput && verifyInput.length > 0
            ? verifyInput
            : project
              ? await autoDetectVerify(project.rootPath)
              : [];
        const normalizedManagerProvider = asNonEmptyString(managerProvider);
        const normalizedManagerModel = asNonEmptyString(managerModel);
        const coherentManagerModel = normalizedManagerProvider ? normalizedManagerModel : undefined;
        const result = await runCoordinator({
          runAgentTurn: turnSeam,
          membersRoot,
          dataHome: scopeDataHome(home, scopeId),
          roster,
          task,
          ...(normalizedManagerProvider ? { managerProvider: normalizedManagerProvider } : {}),
          ...(coherentManagerModel ? { managerModel: coherentManagerModel } : {}),
          abortSignal: ctx.abortSignal,
          publish: async () => {
            await refreshWorkflow?.("squad-coordinator")?.catch(() => {});
          },
          ...(project ? { project } : {}),
          ...(runWorkflowSeam ? { runWorkflow: runWorkflowSeam } : {}),
          ...(memorySeam ? { getMemory: memorySeam } : {}),
          ...(execSeam ? { getExec: execSeam() } : {}),
          ...(verify.length > 0 ? { verify } : {}),
          limits: {
            ...DEFAULT_LIMITS,
            ...(maxRounds !== undefined ? { maxRounds } : {}),
            ...(maxStall !== undefined ? { maxStall } : {}),
            ...(maxResets !== undefined ? { maxResets } : {}),
          },
        });
        // Push the Run-loop panel to the run's final state (the same publish path cast uses);
        // best-effort, so a refresh failure never masks the run's own result.
        await refreshWorkflow?.("squad-coordinator").catch(() => {});
        emitResult(ctx, summarizeCoordinator(result), result.status === "error");
      } catch (e) {
        emitResult(ctx, `squad_coordinate failed: ${errText(e)}`, true);
      }
    },
  };
}

// Auto-detect verify commands from a project's package.json when the operator didn't supply any:
// run whichever of check/typecheck/test scripts exist, via the project's runner (bun if a bun
// lockfile is present, else npm). Returns [] for a non-node project or on any read error — the
// gate then fails OPEN (today's behavior), keeping the rib project-agnostic.
//
// This resolves ONCE at run start (before the loop), so the command LIST is fixed before any code
// edit — a code turn can't add/remove scripts to dodge the gate. It does NOT defend against a code
// turn rewriting a script's BODY (e.g. gutting `test`); that change-quality concern is the
// regression guard's job (issue #52). Operators wanting a tamper-proof check pass `verify`
// explicitly with commands that don't route through editable project scripts.
async function autoDetectVerify(rootPath: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(rootPath, "package.json"), "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg.scripts ?? {};
    const hasBunLock =
      (await pathExists(join(rootPath, "bun.lock"))) ||
      (await pathExists(join(rootPath, "bun.lockb")));
    const runner = hasBunLock ? "bun" : "npm";
    return ["check", "typecheck", "test"]
      .filter((s) => typeof scripts[s] === "string")
      .map((s) => `${runner} run ${s}`);
  } catch {
    return [];
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const COORD_STEP_EXCERPT = 400;

function summarizeCoordinator(result: RunCoordinatorResult): string {
  const lines: string[] = [
    `Coordinator — ${result.status} after ${result.rounds} round(s)`,
    "",
    "Summary:",
    result.summary,
  ];
  if (result.provenance) {
    lines.push("", `Worked by: ${result.provenance}`);
  }
  if (result.ledger.verification) {
    const v = result.ledger.verification;
    lines.push(
      "",
      `Verification: ${v.passed ? "passed" : "FAILED"} — ${v.command}${v.passed ? "" : ` (exit ${v.exitCode})`}`,
    );
  }
  if (result.ledger.plan.length > 0) {
    lines.push("", "Plan:", ...result.ledger.plan.map((s, i) => `${i + 1}. ${s}`));
  }
  if (result.ledger.teamGaps && result.ledger.teamGaps.length > 0) {
    lines.push(
      "",
      "Team gaps (consider casting a specialist):",
      ...result.ledger.teamGaps.map((g) => `- ${g}`),
    );
  }
  const steps = result.ledger.transcript.filter(
    (e) => e.kind === "dispatch" || e.kind === "code" || e.kind === "workflow",
  );
  if (steps.length > 0) {
    lines.push("", "Steps:");
    for (const e of steps) {
      const tag = e.kind === "dispatch" ? "" : ` [${e.kind}]`;
      const touched =
        e.kind === "code" && e.touched
          ? ` (touched ${e.touched.files} file${e.touched.files === 1 ? "" : "s"}, +${e.touched.insertions} -${e.touched.deletions})`
          : "";
      lines.push(
        `- R${e.round} ${e.speaker ?? "team"}${tag}: ${e.text.slice(0, COORD_STEP_EXCERPT)}${touched}`,
      );
    }
  }
  return lines.join("\n");
}

const runsSchema = z.object({ project: z.string().optional() });

function makeRunsTool(projectsSeam: RibContext["getProjects"]): ToolDefinition {
  return {
    name: "squad_runs",
    description:
      "List archived coordinator runs for the resolved squad scope. `project` (optional id/name) resolves scope like squad_coordinate — an unknown project errors; with no project and no selection it lists the default scope. Read-only.",
    inputSchema: runsSchema,
    async execute(input, ctx) {
      const parsed = runsSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_runs: ${parsed.error.message}`, true);
        return;
      }
      try {
        const home = squadDataHome();
        const selection = await readSelectedProject(home);
        const resolution = resolveRunScope(
          projectsSeam,
          asNonEmptyString(parsed.data.project),
          selection,
        );
        // Mirror squad_code / squad_coordinate: a bad EXPLICIT project errors rather than
        // silently listing the default scope, which would mask a typo and ignore the selection.
        if (!resolution.ok) {
          emitResult(ctx, `squad_runs: ${resolution.error}`, true);
          return;
        }
        const runs = await listRuns(scopeDataHome(home, resolution.scopeId));
        emitResult(ctx, summarizeRuns(runs, resolution.scopeId));
      } catch (e) {
        emitResult(ctx, `squad_runs failed: ${errText(e)}`, true);
      }
    },
  };
}

function summarizeRuns(runs: readonly RunSummary[], scopeId: string): string {
  const lines = [
    `Runs — scope "${scopeId}" — ${runs.length} archived run${runs.length === 1 ? "" : "s"}`,
  ];
  if (runs.length === 0) return lines.join("\n");
  lines.push(
    "",
    ...runs.map(
      (run) => `${run.id} | ${run.status} | r${run.round} | ${run.updatedAt} | ${run.task}`,
    ),
  );
  return lines.join("\n");
}

// Shared cast-scan seam: run ONE confined read-only scan of the SELECTED project (the
// read-only rail lives inside proposeCast — cwd + allowedDirectories + read-only tools),
// persist the proposal under the selection's scope where approve-cast reads it, and
// refresh the Proposed-squad panel. Backs the squad_propose_cast tool the squad-cast-scan
// workflow fronts; the roster Cast action only launches that run.
async function proposeCastForSelection(
  mission?: string,
): Promise<{ ok: true; projectName: string; count: number } | { ok: false; error: string }> {
  if (!runAgentTurn) {
    return { ok: false, error: "casting needs the agent-turn seam (unavailable on this harness)" };
  }
  if (!getProjects) {
    return { ok: false, error: "casting needs the projects seam (unavailable on this harness)" };
  }
  const home = squadDataHome();
  const selection = await readSelectedProject(home);
  const projects = getProjects();
  // Resolve the repo to scan: the selection's project when it carries one, else the
  // workspace default project (the flat/default scope IS the workspace, and it is
  // castable). A vanished explicit selection, or no project at all, fails closed.
  const scanProject = selection?.projectId
    ? projects.find((p) => p.id === selection.projectId)
    : projects.find((p) => p.name === DEFAULT_PROJECT_NAME);
  if (!scanProject) {
    return {
      ok: false,
      error:
        projects.length > 0
          ? "select a project in the picker to cast a team for it"
          : "add a project first (keelson project add), then cast a team for it",
    };
  }
  // A provider-listing hiccup must not block casting — degrade to unpinned members.
  let providers: ReturnType<NonNullable<RibContext["getProviders"]>> | undefined;
  try {
    if (getProviders) providers = getProviders();
  } catch {
    providers = [];
  }
  const result = await proposeCast({
    runAgentTurn,
    project: { id: scanProject.id, name: scanProject.name, rootPath: scanProject.rootPath },
    ...(mission ? { mission: mission.slice(0, MAX_MISSION_CHARS) } : {}),
    ...(providers !== undefined ? { providers } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error };
  const scopeId = selectedScopeId(selection);
  const scopedHome = scopeDataHome(home, scopeId);
  const pending = await readProposal(scopedHome);
  if (pending) await retireProposalNames(scopedHome, pending);
  const proposal = await themedProposal(scopedHome, result.proposal);
  await writeProposal(scopedHome, proposal);
  await refreshWorkflow?.("squad-cast");
  return { ok: true, projectName: scanProject.name, count: proposal.members.length };
}

const proposeCastSchema = z.object({ mission: z.string().optional() });

function makeProposeCastTool(): ToolDefinition {
  return {
    name: "squad_propose_cast",
    description:
      "Internal write-seam for the squad-cast-scan workflow: run ONE confined read-only scan of the SELECTED project's repo and persist a proposed squad (the Proposed squad panel) for the operator to Approve or Discard. `mission` (optional) focuses the team. To cast a squad, run the squad-cast-scan workflow (or the roster's Cast action) rather than calling this directly. Fails closed with no selected project or no agent-turn seam.",
    inputSchema: proposeCastSchema,
    state_changing: true,
    async execute(input, ctx) {
      const parsed = proposeCastSchema.safeParse(input);
      if (!parsed.success) {
        emitResult(ctx, `squad_propose_cast: ${parsed.error.message}`, true);
        return;
      }
      const result = await proposeCastForSelection(asNonEmptyString(parsed.data.mission));
      if (!result.ok) {
        emitResult(ctx, `squad_propose_cast: ${result.error}`, true);
        return;
      }
      emitResult(
        ctx,
        JSON.stringify({ ok: true, project: result.projectName, proposed: result.count }),
      );
    },
  };
}

const rib: Rib = {
  id: "squad",
  displayName: "Squad",

  // Binds the rib's keys to the canvas renderer; data arrives when the bound
  // collector/render workflow runs (squad-roster, squad-decisions).
  views: [
    { key: ROSTER_KEY, canvasKind: "view", title: "Roster" },
    { key: DECISIONS_KEY, canvasKind: "view", title: "Decisions" },
    { key: CAST_KEY, canvasKind: "view", title: "Proposed squad" },
    { key: COORDINATOR_KEY, canvasKind: "view", title: "Run loop" },
    { key: SQUAD_RUNS_KEY, canvasKind: "view", title: "Runs" },
    { key: RUN_DETAIL_KEY, canvasKind: "view", title: "Run" },
  ],

  // The Squad nav tab. The roster sits in the header (the members you author); each
  // member is a card with Enter / Set model / Retire. No static actions[]: a
  // payload-less button can't carry input, so genesis is the squad-genesis workflow
  // and the card verbs are payload-carrying board actions that reach onAction.
  surfaces: [
    {
      id: SQUAD_SURFACE_ID,
      title: "Squad",
      subtitle: "Author members · cast a squad · assign work",
      // Opt into the host's project picker: the surface header renders the shared
      // ProjectChip and, on select, dispatches this rib's select-project action.
      projectScoped: true,
      layout: {
        header: {
          key: ROSTER_KEY,
          workflow: "squad-roster",
          title: "Roster",
          // A cheap deterministic collector that only changes on author/retire; a
          // modest cadence keeps it self-populating on open and fresh after a new
          // member without hammering.
          cadenceMs: 120_000,
          glyph: { char: "◆", tone: "brand" },
        },
        rows: [
          {
            columns: [
              {
                key: COORDINATOR_KEY,
                workflow: "squad-coordinator",
                title: "Run loop",
                // Promoted to lead, uncollapsed: assign a task from its composer and
                // watch the coordinator stream round by round. cadenceMs so it
                // auto-loads on open (showing the composer) instead of a "Load"
                // placeholder; `live` pulses the head while a run pushes frames.
                cadenceMs: 120_000,
                live: true,
                collapsible: true,
                glyph: { char: "↻", tone: "info" },
              },
            ],
          },
          {
            columns: [
              {
                key: SQUAD_RUNS_KEY,
                workflow: "squad-runs",
                title: "Runs",
                // The archived coordinator runs. Cheap ledger read; a modest cadence
                // keeps a freshly-launched run appearing without a manual refresh.
                cadenceMs: 120_000,
                collapsible: true,
                glyph: { char: "≡", tone: "neutral" },
              },
              {
                key: CAST_KEY,
                workflow: "squad-cast",
                title: "Proposed squad",
                // NO cadenceMs: the cast collector only changes on propose/approve/
                // discard. squad_propose_cast refreshes it after a scan.
                collapsible: true,
                collapsed: false,
                glyph: { char: "✦", tone: "brand" },
              },
            ],
          },
          {
            columns: [
              {
                key: DECISIONS_KEY,
                workflow: "squad-decisions",
                title: "Decisions",
                // NO cadenceMs by design: squad-decisions runs a paid agent turn to
                // render the recalled ledger, so a heartbeat would burn turns idle.
                // Client SWR refreshes it on open/focus (the region has no cadence);
                // re-open the panel after recording a decision to see it.
                collapsible: true,
                glyph: { char: "§", tone: "accent" },
              },
            ],
          },
        ],
      },
    },
  ],

  contributeWorkflows: () => [
    {
      // The roster producer: a deterministic collector that reads the authored
      // members from the data home and emits a board of cards. Genesis/retire
      // mutate the data home; this refresh reflects it.
      definition: {
        name: "squad-roster",
        description:
          'Use when: you want to see the members of the squad. Triggers: "show the roster", "list members", "who is on the team". Does: reads the authored members from the Squad data home and publishes a roster board (one card per member) to the Squad Roster canvas. NOT for: creating or retiring members (genesis is the squad-genesis workflow; retire is a roster board action).',
        nodes: [
          {
            id: "collect",
            // The collector runs out-of-process (a bash node) and can't call
            // ctx.getDataDir, so bake the resolved data home in — captured in
            // registerTools, which runs before this — so both sides read one path.
            bash: `bun ${shQuote(ROSTER_COLLECTOR)} ${shQuote(squadDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: ROSTER_KEY,
      validate: expectView(ROSTER_KEY, "board"),
    },
    {
      // The cast producer: a deterministic collector that renders the pending
      // cast-proposal.json as the Proposed-squad board. cast-propose writes the
      // proposal then refreshes this; approve/discard clear it and refresh again.
      definition: {
        name: "squad-cast",
        description:
          'Use when: review the squad auto-composed for a project. Triggers: the roster "Cast a squad" action, opening the Proposed squad panel. Does: reads the pending cast proposal from the Squad data home and publishes a "Proposed squad" board (one card per proposed member) to the Squad Cast canvas. NOT for: scanning a project (the cast-propose board action) or scaffolding the members (the Approve action).',
        nodes: [
          {
            id: "collect",
            bash: `bun ${shQuote(CAST_COLLECTOR)} ${shQuote(squadDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: CAST_KEY,
      validate: expectView(CAST_KEY, "board"),
    },
    {
      // The coordinator producer: a deterministic collector that renders the persisted
      // coordinator-ledger.json as the Run-loop board. squad_coordinate writes the ledger each
      // round and refreshes this on completion; a missing ledger renders the idle board.
      definition: {
        name: "squad-coordinator",
        description:
          'Use when: watch the squad\'s coordinator run loop. Triggers: opening the Run loop panel, after a squad_coordinate run. Does: reads the persisted coordinator ledger from the Squad data home and publishes a "Run loop" board (goal, plan, findings, abandoned steps, recent activity) to the Squad Run-loop canvas. NOT for: starting a run (that is the squad_coordinate tool).',
        nodes: [
          {
            id: "collect",
            bash: `bun ${shQuote(COORDINATOR_COLLECTOR)} ${shQuote(squadDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: COORDINATOR_KEY,
      validate: expectView(COORDINATOR_KEY, "board"),
    },
    {
      // The runs producer: a deterministic collector that renders the archived
      // coordinator run ledgers under the selected scope as the Runs history board.
      // The coordinator archives each completed run; this refresh reflects them.
      definition: {
        name: "squad-runs",
        description:
          "Use when: see the squad's past coordinator runs. Triggers: opening the Runs panel. Does: reads the archived run ledgers from the selected scope and publishes a Runs board (one row per run, newest first) to the Squad Runs canvas. NOT for: starting a run (the Run-loop Coordinate action) or watching the current one (the Run loop panel).",
        nodes: [
          {
            id: "collect",
            bash: `bun ${shQuote(RUNS_COLLECTOR)} ${shQuote(squadDataHome())}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: SQUAD_RUNS_KEY,
      validate: expectView(SQUAD_RUNS_KEY, "board"),
    },
    {
      // Genesis as a workflow: one prompt turn authors the charter and calls
      // squad_emit_member to persist it. No bindSnapshotKey/validate — genesis
      // writes files (the roster collector reflects them), it does not publish a
      // board. allowed_tools scopes the turn to the single write seam: rib tools
      // are default-off in workflow prompt nodes, so it must opt in by name.
      definition: {
        name: "squad-genesis",
        description:
          'Use when: create a new squad member. Triggers: "add a member", "new teammate", "/workflow run squad-genesis <brief>". Does: one agent turn reads a brief, authors a charter.md, and persists the member via squad_emit_member. NOT for: retiring a member or editing an existing one.',
        nodes: [
          {
            id: "author",
            prompt: GENESIS_WF_PROMPT,
            // Fail closed: squad_emit_member writes the member and fails closed on a
            // slug collision; fail_on_tool_error makes that error fail the run
            // instead of reporting SUCCEEDED with no member written.
            fail_on_tool_error: true,
            allowed_tools: ["squad_emit_member"],
          },
        ],
      },
    },
    {
      // Surface-launched: casting a squad as an inspectable workflow run. One prompt
      // turn calls squad_propose_cast (the confined read-only scan) — the roster Cast
      // action launches THIS instead of scanning in-process, so "create a squad"
      // triggers a visible run. No bindSnapshotKey: the tool refreshes the Proposed
      // squad panel itself; this workflow just fronts the scan.
      definition: {
        name: "squad-cast-scan",
        description:
          'Use when: auto-compose a squad for the selected project. Triggers: the roster "Cast a squad" action. Does: one agent turn calls squad_propose_cast to run a confined read-only repo scan and publish a Proposed squad to Approve or Discard. NOT for: authoring one member (squad-genesis) or approving a proposal (the Proposed squad board actions).',
        nodes: [
          {
            id: "scan",
            prompt: CAST_SCAN_WF_PROMPT,
            fail_on_tool_error: true,
            allowed_tools: ["squad_propose_cast"],
          },
        ],
      },
    },
    {
      // Surface-launched: run the coordinator on a task as an inspectable run. The tool
      // publishes the Run-loop panel per round, so progress streams there while the run
      // is live; maxRounds is clamped low for a surface run (see COORDINATE_WF_PROMPT).
      definition: {
        name: "squad-coordinate-run",
        description:
          'Use when: hand the squad a task and watch it run the plan→delegate→observe loop. Triggers: the Run-loop "Coordinate on a task" action. Does: one agent turn calls squad_coordinate (bounded rounds) against the selected project; progress streams into the Run loop panel. NOT for: a single one-off question (squad-dispatch-run) or one direct code edit (squad-code-run).',
        nodes: [
          {
            id: "run",
            prompt: COORDINATE_WF_PROMPT,
            fail_on_tool_error: true,
            allowed_tools: ["squad_coordinate"],
          },
        ],
      },
    },
    {
      // Surface-launched: fan one question out to the whole roster and synthesize.
      definition: {
        name: "squad-dispatch-run",
        description:
          'Use when: ask every squad member one question at once. Triggers: the Run-loop "Ask the team" action. Does: one agent turn calls squad_dispatch to fan the question out to all active members and synthesize their replies. NOT for: a multi-step run (squad-coordinate-run) or editing the repo (squad-code-run).',
        nodes: [
          {
            id: "ask",
            prompt: DISPATCH_WF_PROMPT,
            fail_on_tool_error: true,
            allowed_tools: ["squad_dispatch"],
          },
        ],
      },
    },
    {
      // Surface-launched: one code-capable member edits the selected project's repo.
      definition: {
        name: "squad-code-run",
        description:
          'Use when: assign a confined coding task to one code-capable member. Triggers: a roster card\'s "Assign a code task" action. Does: one agent turn calls squad_code so the named member edits the selected project directly (Read/Edit/Write/Bash, confined to the repo, no merge/force-push). NOT for: text-only reasoning (squad-dispatch-run) or a whole multi-step run (squad-coordinate-run).',
        nodes: [
          {
            id: "code",
            prompt: CODE_WF_PROMPT,
            fail_on_tool_error: true,
            allowed_tools: ["squad_code"],
          },
        ],
      },
    },
    {
      // The governed-decision write path. A rib runs in-process and has NO seam to
      // call the memory ledger directly, so the supported path is a declarative
      // `memory: { writeback }` block the executor runs SERVER-SIDE after the node.
      // A cheap bash node (no paid turn) carries it; the decision's summary/content
      // come from $inputs (the record-decision board action / a CLI run). The
      // executor hard-codes provenance "generated" (evidence-default — a decision
      // is reviewable, not auto-instruction). `decision` needs no sourceRef. The
      // bash body is a constant (never interpolates $inputs) so a typed summary can't
      // reach the shell. No bindSnapshotKey — it writes a ledger row, not a board.
      definition: {
        name: "squad-decide",
        description:
          'Use when: the squad reaches a decision worth remembering across sessions. Triggers: "record a decision", "we decided", the Decisions panel\'s Record action. Does: writes one governed `decision` row to the project memory ledger from { summary, content } (server-side, evidence-default). NOT for: a member\'s private note (squad_remember) or viewing the ledger (squad-decisions).',
        nodes: [
          {
            id: "record",
            bash: "echo 'squad: decision recorded to the ledger'",
            memory: {
              writeback: {
                on: "success",
                type: "decision",
                summary: "$inputs.summary",
                content: "$inputs.content",
              },
            },
          },
        ],
      },
    },
    {
      // The governed-decision READ path: one node whose `memory: { recall }` block
      // runs server-side first (substituting the recalled rows into
      // $memory.recall.items), then a prompt turn renders them into the decisions
      // board. output_schema gates the shape; bindSnapshotKey republishes the board
      // to the Decisions panel; expectView re-validates fail-closed at the edge.
      // Costs one paid turn per render — the surface region carries NO cadence so it
      // only runs on open/refresh (see the layout note).
      definition: {
        name: "squad-decisions",
        description:
          'Use when: you want to see the squad\'s governed decisions and lessons. Triggers: "show decisions", "what have we decided", opening the Decisions panel. Does: recalls decision/lesson rows from the project memory ledger and renders them as a board on the Squad Decisions canvas. NOT for: recording a decision (squad-decide) or a member\'s private memory (squad_remember).',
        nodes: [
          {
            id: "render",
            memory: {
              recall: {
                query: "team decisions and lessons",
                limits: { maxItems: 50 },
              },
            },
            prompt: DECISIONS_WF_PROMPT,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: DECISIONS_KEY,
      validate: expectView(DECISIONS_KEY, "board"),
    },
  ],

  // The governance floor chamber skips: a non-overridable RAI policy the harness
  // evaluates first-deny-wins on every squad agent turn (deny a self-merge /
  // force-push, fail a BLOCK review verdict). Collected once at boot like
  // contributeWorkflows; the policies are pure, so the ctx is unused.
  contributePolicies: () => squadPolicies(),

  registerTools: (ctx: RibContext) => {
    // Capture the data home from the blessed ctx.getDataDir seam once, before
    // contributeWorkflows bakes the path into the roster bash node. When the seam is
    // absent (older harness), leave it uncaptured: squadDataHome() lazily resolves
    // ribDataDir("squad").
    const dataDir = ctx.getDataDir?.();
    if (dataDir) setSquadDataHome(dataDir);
    // Capture the refresh seam for the write tools + onAction handlers, and the
    // turn/projects seams for later phases. dispose() clears them so a re-boot
    // recaptures the new ctx's.
    refreshWorkflow = ctx.refreshWorkflow;
    runAgentTurn = ctx.runAgentTurn;
    getProjects = ctx.getProjects;
    getProviders = ctx.getProviders;
    // The run-detail key composes from module state the View action sets; registered
    // here (the only hook with the ctx) and unregistered in dispose so a re-boot
    // re-registers cleanly against the new manager.
    snapshots = ctx.getSnapshotManager?.();
    unregisterRunDetail?.();
    unregisterRunDetail = snapshots?.register(
      RUN_DETAIL_KEY,
      () => runDetailBoard ?? buildRunDetailBoard(undefined, "none"),
    );
    // Seed the picker's project list so it has options on first render.
    snapshotProjects();
    return [
      makeEmitMemberTool(ctx.refreshWorkflow, ctx.getProjects),
      makeListMembersTool(ctx.getProjects),
      makeRetireMemberTool(ctx.refreshWorkflow, ctx.getProjects),
      makeRememberTool(),
      makeDispatchTool(ctx.runAgentTurn),
      makeCodeTool(ctx.runAgentTurn, ctx.getProjects),
      makeOpenPrTool(ctx.getProjects, ctx.getExec),
      makeViewDiffTool(ctx.getProjects, ctx.getExec),
      makeProposeCastTool(),
      makeRunsTool(ctx.getProjects),
      makeCoordinateTool(
        ctx.runAgentTurn,
        ctx.getProjects,
        ctx.runWorkflow,
        ctx.getMemory,
        ctx.getExec,
      ),
    ];
  },

  // Board verbs. Actions relayed from a sandboxed HTML canvas arrive with origin
  // "canvas-html" (the host stamps it; a frame can't forge it). There is no chart
  // iframe in Phase 0, so any frame-origin action is rejected outright; trusted
  // board actions (origin absent) keep the full verb surface below.
  onAction: (action) => {
    if (action.origin === "canvas-html") {
      return { ok: false, error: `'${action.type}' is not permitted from an HTML canvas` };
    }
    // Keep the picker's project list current on every interaction.
    snapshotProjects();
    switch (action.type) {
      case "enter-member":
        return enterMemberAction(action);
      case SELECT_PROJECT_ACTION:
        return selectProjectAction(action);
      case "author-archetype":
        return authorArchetypeAction(action);
      case "describe-own":
        return describeOwnAction(action);
      case CAST_PROPOSE_ACTION:
        return castProposeAction(action);
      case APPROVE_CAST_ACTION:
        return approveCastAction();
      case DISCARD_CAST_ACTION:
        return discardCastAction();
      case "set-model":
        return setModelAction(action);
      case "retire":
        return retireAction(action);
      case RETIRE_ALL_ACTION:
        return retireAllAction();
      case COORDINATE_ACTION:
        return coordinateAction(action);
      case DISPATCH_ACTION:
        return dispatchAction(action);
      case ASSIGN_CODE_ACTION:
        return assignCodeAction(action);
      case RECORD_DECISION_ACTION:
        return recordDecisionAction(action);
      case VIEW_RUN_ACTION:
        return viewRunAction(action);
      default:
        return { ok: false, error: `unknown action '${action.type}'` };
    }
  },

  // Agents: every member is enterable as a keelson agent (GET /api/agents).
  // resolveAgent builds the same seed the roster Enter action does (buildSeedFor),
  // so the two entry points can't drift.
  listAgents: () => listAgents(),
  resolveAgent: (slug: string) => resolveAgent(slug),

  // The data home is the only hard requirement; runAgentTurn/getProjects are noted
  // when present but inert in Phase 0, so their absence is not a failure.
  authStatus: async (): Promise<RibAuthStatus> => {
    if (!(await isSquadDataHomeWritable())) {
      return {
        authenticated: false,
        statusMessage: `data home not writable: ${squadDataHome()}`,
      };
    }
    const seams = [runAgentTurn ? "agent-turn" : null, getProjects ? "projects" : null].filter(
      (s): s is string => Boolean(s),
    );
    const note = seams.length > 0 ? ` (seams: ${seams.join(", ")})` : "";
    return { authenticated: true, statusMessage: `roster wired${note}` };
  },

  dispose: () => {
    setSquadDataHome(undefined);
    refreshWorkflow = undefined;
    runAgentTurn = undefined;
    getProjects = undefined;
    getProviders = undefined;
    unregisterRunDetail?.();
    unregisterRunDetail = undefined;
    snapshots = undefined;
    runDetailBoard = undefined;
  },
};

// Open a member as a seeded chat: compose its charter into a system prompt and hand
// the harness an "open-chat" directive (the generic seam the SPA interprets to
// start a fresh seeded conversation). Read-only against members/.
async function enterMemberAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "enter-member requires payload { slug }" };
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    const membersRoot = scopeMembersDir(home, scopeId);
    const member = (await readMembers(membersRoot)).find((m) => m.slug === slug);
    if (!member) return { ok: false, error: `unknown member: ${slug}` };
    const seed = await buildSeedFor(membersRoot, member);
    return { ok: true, data: { effect: "open-chat", seed } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Select-project: persist the operator's project selection — the scopeId every
// scoped data path keys on. "default" picks the legacy flat scope; any other id is
// validated against the live project catalog (a stale board button can't select a
// removed project). Refreshes projects.json + the three scope-bound panels.
async function selectProjectAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const scopeId = asNonEmptyString(payload.scopeId);
  if (!scopeId) return { ok: false, error: "select-project requires payload { scopeId }" };
  const home = squadDataHome();
  const at = new Date().toISOString();
  try {
    if (scopeId === DEFAULT_SCOPE_ID) {
      await writeSelectedProject(home, { scopeId: DEFAULT_SCOPE_ID, at });
    } else {
      const project = getProjects?.().find((p) => p.id === scopeId);
      if (!project) return { ok: false, error: "unknown project" };
      // The workspace default project maps to the flat scope (so a legacy roster
      // stays visible) but keeps its projectId + rootPath so it is still castable and
      // runnable; every other project scopes by its own id.
      const effectiveScope = project.name === DEFAULT_PROJECT_NAME ? DEFAULT_SCOPE_ID : project.id;
      await writeSelectedProject(home, {
        scopeId: effectiveScope,
        projectId: project.id,
        name: project.name,
        rootPath: project.rootPath,
        at,
      });
    }
    await writeProjectsSnapshot(
      home,
      (getProjects?.() ?? []).map((p) => ({ id: p.id, name: p.name })),
    );
    await refreshWorkflow?.("squad-roster")?.catch(() => {});
    await refreshWorkflow?.("squad-cast")?.catch(() => {});
    await refreshWorkflow?.("squad-coordinator")?.catch(() => {});
    await refreshWorkflow?.("squad-runs")?.catch(() => {});
    return { ok: true, data: { scopeId } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Author one of the starter archetypes: launch squad-genesis with the starter's
// brief, the same path describe-own takes.
function authorArchetypeAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  const starter = GENESIS_STARTERS.find((s) => s.slug === slug);
  if (!starter) return { ok: false, error: `unknown archetype: ${slug || "(none)"}` };
  return {
    ok: true,
    data: { effect: "run-workflow", workflow: "squad-genesis", args: { brief: starter.brief } },
  };
}

// The operator-typed brief is the only unbounded, user-controlled input here;
// clamp it before it rides into a billed genesis run.
const MAX_BRIEF_CHARS = 2000;

// Author from a freeform brief: launch squad-genesis with the brief.
function describeOwnAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const brief = asNonEmptyString(payload.brief);
  if (!brief) return { ok: false, error: "Describe the member first — who should it be?" };
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-genesis",
      args: { brief: brief.slice(0, MAX_BRIEF_CHARS) },
    },
  };
}

// The operator-typed mission is unbounded, user-controlled input; clamp it before
// it rides into a billed scan turn.
const MAX_MISSION_CHARS = 2000;

// Resolve a project from a free-text selector (a project name or id), matched LIVE
// against getProjects() at action time so it never goes stale. Blank selects the sole
// project, else the conventional `default`; an ambiguous or unknown selector fails
// closed listing the choices, so a confined turn (cast scan / code mode) only ever
// runs against a real, confinable root.
function resolveProject(
  projects: readonly Project[],
  selector: string | undefined,
): { ok: true; project: Project } | { ok: false; error: string } {
  if (projects.length === 0) {
    return { ok: false, error: "no projects to cast for — add a project first" };
  }
  const names = projects.map((p) => p.name).join(", ");
  if (selector) {
    const match = projects.find((p) => p.id === selector || p.name === selector);
    return match
      ? { ok: true, project: match }
      : { ok: false, error: `unknown project "${selector}" — known projects: ${names}` };
  }
  if (projects.length === 1) return { ok: true, project: projects[0]! };
  const fallback = projects.find((p) => p.name === DEFAULT_PROJECT_NAME);
  if (fallback) return { ok: true, project: fallback };
  return { ok: false, error: `several projects — name one to cast for: ${names}` };
}

// The SINGLE scope resolution shared by squad_coordinate and squad_code, with the
// SELECTION as the source of truth. An EXPLICIT arg overrides to that project's own
// scope + team and MUST resolve (errors if unknown). Otherwise the selection binds
// members + ledger to the selection's scope regardless of whether that project still
// exists in core: a STALE selection degrades to reasoning-only (no boundProject)
// WITHOUT moving the scope, so the cast team there stays reachable. No explicit + no
// selection runs reasoning-only on the default scope. resolveProject's sole-project
// auto-pick is reserved for an EXPLICIT selector — never the empty/selection path
// (that auto-pick was the regression: a default-scope team went invisible to a no-arg
// run, which auto-bound to the sole project's own empty scope instead).
function resolveRunScope(
  projectsSeam: RibContext["getProjects"],
  explicit: string,
  selection: SelectedProject | undefined,
): { ok: true; scopeId: string; project?: Project } | { ok: false; error: string } {
  if (explicit) {
    if (!projectsSeam) return { ok: false, error: "projects seam unavailable on this harness" };
    const resolved = resolveProject(projectsSeam(), explicit);
    if (!resolved.ok) return resolved;
    return { ok: true, scopeId: resolved.project.id, project: resolved.project };
  }
  if (selection?.projectId) {
    const project = projectsSeam?.().find((p) => p.id === selection.projectId);
    return { ok: true, scopeId: selectedScopeId(selection), ...(project ? { project } : {}) };
  }
  return { ok: true, scopeId: DEFAULT_SCOPE_ID };
}

// Cast-propose: preflight a scannable project (immediate, helpful errors), then launch
// the squad-cast-scan workflow so the confined repo scan runs as an inspectable run
// rather than in-process — the fix for "creating a squad doesn't trigger a workflow".
// The scan itself lives in squad_propose_cast (read-only, bounded to the project root
// inside proposeCast); this action only validates and launches. Casting is
// selection-driven — the selection's project, or the workspace default project for the
// flat/default scope (no free-text override footgun). stay:true keeps the
// operator on Squad while the Proposed squad panel refreshes for review.
async function castProposeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  if (!runAgentTurn) {
    return { ok: false, error: "casting needs the agent-turn seam (unavailable on this harness)" };
  }
  if (!getProjects) {
    return { ok: false, error: "casting needs the projects seam (unavailable on this harness)" };
  }
  const projects = getProjects();
  const selection = await readSelectedProject(squadDataHome());
  // A scannable target: the selection's project when it carries one, else the workspace
  // default project (the flat/default scope). Only a vanished explicit selection or no
  // project at all fails closed (mirrors proposeCastForSelection).
  const hasTarget = selection?.projectId
    ? projects.some((p) => p.id === selection.projectId)
    : projects.some((p) => p.name === DEFAULT_PROJECT_NAME);
  if (!hasTarget) {
    return {
      ok: false,
      error:
        projects.length > 0
          ? "select a project in the picker to cast a team for it"
          : "add a project first (keelson project add), then cast a team for it",
    };
  }
  const mission = asNonEmptyString(payload.mission);
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-cast-scan",
      args: mission ? { mission: mission.slice(0, MAX_MISSION_CHARS) } : {},
      stay: true,
    },
  };
}

// The operator-typed task is unbounded, user-controlled input; clamp it before it
// rides into a billed assign-work run (the tools re-cap their own inputs too).
const MAX_TASK_CHARS = 4000;

// Coordinate: launch the Magentic run loop on a task. stay:true — the promoted
// Run-loop panel on the Squad surface is where the run streams round by round.
function coordinateAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const task = asNonEmptyString(payload.task);
  if (!task) return { ok: false, error: "Describe the task first — what should the squad do?" };
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-coordinate-run",
      args: { task: task.slice(0, MAX_TASK_CHARS) },
      stay: true,
    },
  };
}

// Ask the team: fan one question out to the whole roster. Focuses Workflows — the
// synthesized answer is the run's output, read in the run view.
function dispatchAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const task = asNonEmptyString(payload.task);
  if (!task) {
    return { ok: false, error: "Ask a question first — what should the team weigh in on?" };
  }
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-dispatch-run",
      args: { task: task.slice(0, MAX_TASK_CHARS) },
    },
  };
}

// Assign a code task: one code-capable member edits the selected project. The card
// carries the member slug; squad_code resolves the repo from the selection. Focuses
// Workflows — the code summary is the run's output.
async function assignCodeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  const task = asNonEmptyString(payload.task);
  if (!slug) return { ok: false, error: "assign-code requires payload { slug }" };
  if (!task) {
    return {
      ok: false,
      error: "Describe the code task first — what should this member implement?",
    };
  }
  // Preflight the member in the selected scope BEFORE launching a billed run — a stale
  // card button (or a direct dispatch) would otherwise kick off a squad-code-run that
  // is guaranteed to fail. These checks mirror squad_code's own so the two can't drift.
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    const member = (await readMembers(scopeMembersDir(home, scopeId))).find((m) => m.slug === slug);
    if (!member) return { ok: false, error: `unknown member "${slug}"` };
    if (member.status !== "active") return { ok: false, error: `member "${slug}" is not active` };
    if (!memberCanCode(member)) {
      return {
        ok: false,
        error: `member "${slug}" lacks the "code" capability — only code-tagged members may modify the repo`,
      };
    }
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-code-run",
      args: { member: slug, task: task.slice(0, MAX_TASK_CHARS) },
    },
  };
}

// Retire-all: remove every member in the selected scope — the "remove the squad" verb.
// Reuses the per-member retire path (record + charter delete, then free the cast name)
// over the whole scoped roster, then refreshes the roster panel. Reads the live roster
// as the source of truth so a stale board button retires exactly what is there now.
async function retireAllAction(): Promise<RibActionResult> {
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    const membersRoot = scopeMembersDir(home, scopeId);
    const scopedHome = scopeDataHome(home, scopeId);
    const members = await readMembers(membersRoot);
    if (members.length === 0) return { ok: false, error: "no members to retire in this scope" };
    let retired = 0;
    for (const m of members) {
      try {
        await retireMember(membersRoot, m.slug);
        retired++;
      } catch (e) {
        // Only the already-gone case is expected (a concurrent retire between the read
        // above and here); any OTHER error is real — free the cast name, then fail the
        // action so a partial retire is reported, not silently under-counted.
        if (!errText(e).includes("not found")) {
          await retireCastingName(scopedHome, m.slug);
          await refreshWorkflow?.("squad-roster")?.catch(() => {});
          return { ok: false, error: `retire-all failed on "${m.slug}": ${errText(e)}` };
        }
      }
      await retireCastingName(scopedHome, m.slug);
    }
    await refreshWorkflow?.("squad-roster")?.catch(() => {});
    return { ok: true, data: { retired } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Read the persisted proposal as the source of truth so stale board buttons can't
// approve a discarded proposal.
async function approveCastAction(): Promise<RibActionResult> {
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    const scopedHome = scopeDataHome(home, scopeId);
    const proposal = await readProposal(scopedHome);
    if (!proposal) return { ok: false, error: "no proposal to approve — cast a squad first" };
    const at = new Date().toISOString();
    const records: MemberRecord[] = [];
    for (let i = 0; i < proposal.members.length; i++) {
      const m = proposal.members[i]!;
      records.push({
        // A drifted or hand-edited proposal slug must not fail the whole approve —
        // slugify passes safe slugs through unchanged.
        slug: slugify(m.slug?.trim() || m.name),
        name: m.name,
        role: m.role,
        charter: m.charter,
        status: "active",
        createdAt: at,
        identitySlot: m.identitySlot ?? identitySlotForIndex(i),
        ...(m.themeId ? { themeId: m.themeId } : {}),
        ...(m.personality ? { personality: m.personality } : {}),
        ...(m.backstory ? { backstory: m.backstory } : {}),
        originalName: m.originalName ?? m.name,
        ...(m.provider ? { provider: m.provider } : {}),
        ...(m.provider && m.model ? { model: m.model } : {}),
        ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
      });
    }
    const outcome = await scaffoldRoster(scopeMembersDir(home, scopeId), records);
    await clearProposal(scopedHome);
    await refreshWorkflow?.("squad-roster");
    await refreshWorkflow?.("squad-cast");
    return {
      ok: true,
      data: {
        created: outcome.created,
        skipped: outcome.skipped,
        truncated: outcome.truncated,
      },
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Discard-cast: drop the pending proposal and refresh the (now idle) cast panel.
async function discardCastAction(): Promise<RibActionResult> {
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    const scopedHome = scopeDataHome(home, scopeId);
    const proposal = await readProposal(scopedHome);
    if (proposal) await retireProposalNames(scopedHome, proposal);
    await clearProposal(scopedHome);
    await refreshWorkflow?.("squad-cast");
    return { ok: true, data: { discarded: true } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function setModelAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "set-model requires payload { slug }" };
  const model = asNonEmptyString(payload.model);
  const provider = asNonEmptyString(payload.provider);
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home));
    await setMemberModel(scopeMembersDir(home, scopeId), slug, { model, provider });
    await refreshWorkflow?.("squad-roster");
    return { ok: true, data: { slug, ...(model ? { model } : {}) } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

async function retireAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const slug = asNonEmptyString(payload.slug);
  if (!slug) return { ok: false, error: "retire requires payload { slug }" };
  const home = squadDataHome();
  const scopeId = selectedScopeId(await readSelectedProject(home));
  const scopedHome = scopeDataHome(home, scopeId);
  try {
    await retireMember(scopeMembersDir(home, scopeId), slug);
    // Free the cast name so the ensemble can reuse it (fail-soft, never throws).
    await retireCastingName(scopedHome, slug);
    await refreshWorkflow?.("squad-roster")?.catch(() => {});
    return { ok: true, data: { slug } };
  } catch (e) {
    // retireMember throws when the dir is already gone, but a registry entry can linger
    // (a phantom reservation); free the cast name here too, same as the tool path.
    await retireCastingName(scopedHome, slug);
    return { ok: false, error: errText(e) };
  }
}

// The operator-typed decision text is unbounded, user-controlled input; clamp it
// before it rides into a workflow run (the ledger re-caps at MEMORY_TEXT_LIMIT).
const MAX_DECISION_CHARS = 4000;

// Record a decision: launch squad-decide with the form fields as $inputs. The
// governed write happens server-side in squad-decide's memory writeback block, so
// there is no rib hook to refresh the panel on completion — the Decisions region
// carries no cadence and re-runs on open/focus (client SWR), surfacing the new row.
// View one archived run: load its ledger from the selected scope, publish the
// drill-down board under the run-detail key, and hand the SPA an open-canvas effect
// pointing at it. Every failure mode renders as a board (not-found) or an error
// string — never a throw.
async function viewRunAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const id = asNonEmptyString(payload.id);
  if (!id) return { ok: false, error: "view-run needs the run's id" };
  if (!snapshots) {
    return { ok: false, error: "run drill-down unavailable: no snapshot seam on this harness" };
  }
  try {
    const home = squadDataHome();
    const scopeId = selectedScopeId(await readSelectedProject(home).catch(() => undefined));
    const ledger = await loadRun(scopeDataHome(home, scopeId), id);
    const members = await readMembers(scopeMembersDir(home, scopeId)).catch(() => []);
    runDetailBoard = buildRunDetailBoard(ledger, id, identityTonesByMember(members));
    await snapshots.recompose(RUN_DETAIL_KEY);
    return {
      ok: true,
      data: { effect: "open-canvas", key: RUN_DETAIL_KEY, title: `Run ${id}` },
    };
  } catch (e) {
    return { ok: false, error: `view-run failed: ${errText(e)}` };
  }
}

function recordDecisionAction(action: RibAction): RibActionResult {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const summary = asNonEmptyString(payload.summary);
  const content = asNonEmptyString(payload.content);
  if (!summary) return { ok: false, error: "Describe the decision first — what was decided?" };
  if (!content)
    return { ok: false, error: "Add the decision's details (why, context, consequences)." };
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "squad-decide",
      args: {
        summary: summary.slice(0, MAX_DECISION_CHARS),
        content: content.slice(0, MAX_DECISION_CHARS),
      },
    },
  };
}

export default rib;

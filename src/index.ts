import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Project,
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { asNonEmptyString, DEFAULT_PROJECT_NAME, errText, expectView, z } from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { APPROVE_CAST_ACTION, CAST_PROPOSE_ACTION, DISCARD_CAST_ACTION } from "./boards/cast.ts";
import { buildDecisionsBoard, RECORD_DECISION_ACTION } from "./boards/decisions.ts";
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
import { type DispatchOutcome, dispatchFanout } from "./dispatch.ts";
import { CAST_KEY, COORDINATOR_KEY, DECISIONS_KEY, ROSTER_KEY, SQUAD_SURFACE_ID } from "./keys.ts";
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
import { DEFAULT_LIMITS } from "./orchestrator.ts";
import { isSquadDataHomeWritable, membersDir, setSquadDataHome, squadDataHome } from "./paths.ts";
import { squadPolicies } from "./policies.ts";
import { GENESIS_STARTERS } from "./starters.ts";
import type { TurnOutcome } from "./turn-runner.ts";
import type { Member } from "./types.ts";

// Seams captured in registerTools (the only hook with the full ctx) and cleared in
// dispose. refreshWorkflow re-runs a bound collector (squad-roster, squad-cast)
// after a mutation so the panel updates promptly instead of waiting on cadence;
// runAgentTurn backs squad_dispatch (the fan-out coordinator) and the cast-propose
// repo-scan; getProjects resolves the project a cast scan is confined to.
let refreshWorkflow: RibContext["refreshWorkflow"];
let runAgentTurn: RibContext["runAgentTurn"];
let getProjects: RibContext["getProjects"];
let getProviders: RibContext["getProviders"];

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

// POSIX single-quote: wrap a value and escape any embedded quote so a path
// (spaces, `$`, backticks, backslashes) reaches `bash -c` literally — never
// word-split or expanded.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
async function themedRecord(base: {
  name: string;
  role: string;
  charter: string;
  createdAt: string;
  model?: string;
  provider?: string;
  tools?: readonly string[];
}): Promise<MemberRecord> {
  const id = await assignThemedIdentity(squadDataHome(), {
    proposedName: base.name,
    role: base.role,
  });
  const charter =
    id.themeId && id.personality
      ? foldThemedCharter(base.charter, {
          name: id.name,
          personality: id.personality,
          backstory: id.backstory ?? "",
          themeLabel: themeLabel(id.themeId) ?? id.themeId,
        })
      : base.charter;
  return {
    slug: id.slug,
    name: id.name,
    role: base.role,
    charter,
    status: "active",
    createdAt: base.createdAt,
    ...(id.themeId ? { themeId: id.themeId } : {}),
    ...(id.personality ? { personality: id.personality } : {}),
    ...(id.backstory ? { backstory: id.backstory } : {}),
    ...(id.originalName !== id.name ? { originalName: id.originalName } : {}),
    ...(base.provider ? { provider: base.provider } : {}),
    ...(base.provider && base.model ? { model: base.model } : {}),
    ...(base.tools && base.tools.length > 0 ? { tools: [...base.tools] } : {}),
  };
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
  provider: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

function makeEmitMemberTool(refresh?: RibContext["refreshWorkflow"]): ToolDefinition {
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
        const model = rawModel?.trim();
        const provider = rawProvider?.trim();
        const dedupedTools = tools
          ? [...new Set(tools.map((t) => t.trim()).filter((t) => t.length > 0))]
          : [];
        const record = await themedRecord({
          name,
          role,
          charter,
          createdAt: new Date().toISOString(),
          ...(provider ? { provider } : {}),
          ...(provider && model ? { model } : {}),
          ...(dedupedTools.length > 0 ? { tools: dedupedTools } : {}),
        });
        await scaffoldMember(membersDir(), record);
        // Re-run the bound squad-roster collector so the new member appears
        // promptly instead of waiting on cadence. Fail-soft (the seam resolves on
        // error and is absent on an older harness) — never throw.
        await refresh?.("squad-roster");
        emitResult(ctx, JSON.stringify({ ok: true, slug: record.slug, name: record.name }));
      } catch (e) {
        emitResult(ctx, `squad_emit_member failed: ${errText(e)}`, true);
      }
    },
  };
}

function makeListMembersTool(): ToolDefinition {
  return {
    name: "squad_list_members",
    description:
      "List the squad's members (the roster): each member's slug, name, role, charter, status, and any pinned model/provider and capability tools. Read-only. NOT for creating a member (run the squad-genesis workflow) or retiring one (squad_retire_member).",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      try {
        const members = await readMembers(membersDir());
        emitResult(ctx, JSON.stringify({ members }));
      } catch (e) {
        emitResult(ctx, `squad_list_members failed: ${errText(e)}`, true);
      }
    },
  };
}

const memberRetireSchema = z.object({ slug: z.string().min(1) });

function makeRetireMemberTool(refresh?: RibContext["refreshWorkflow"]): ToolDefinition {
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
      try {
        await retireMember(membersDir(), parsed.data.slug);
        // Free the cast name so the ensemble can reuse it (fail-soft, never throws).
        await retireCastingName(squadDataHome(), parsed.data.slug);
        await refresh?.("squad-roster");
        emitResult(ctx, JSON.stringify({ ok: true, slug: parsed.data.slug }));
      } catch (e) {
        // retireMember throws when the dir is already gone — but a registry entry can
        // linger with no dir (a phantom reservation from a failed scaffold). Free it
        // here too, or that character name is consumed forever.
        await retireCastingName(squadDataHome(), parsed.data.slug);
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
        if (target === "memory") {
          await writeMemory(membersDir(), slug, text);
        } else {
          await appendLog(membersDir(), slug, text, new Date().toISOString());
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
        const active = (await readMembers(membersDir())).filter((m) => m.status === "active");
        const wanted = requested && requested.length > 0 ? new Set(requested) : undefined;
        const members = wanted ? active.filter((m) => wanted.has(m.slug)) : active;
        if (members.length === 0) {
          emitResult(ctx, "squad_dispatch: no matching active members to dispatch to", true);
          return;
        }
        const outcome = await dispatchFanout({
          runAgentTurn: turnSeam,
          membersRoot: membersDir(),
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
      const { member: slug, task, project: selector } = parsed.data;
      try {
        const resolved = resolveProject(projectsSeam(), selector);
        if (!resolved.ok) {
          emitResult(ctx, `squad_code: ${resolved.error}`, true);
          return;
        }
        const member = (await readMembers(membersDir())).find((m) => m.slug === slug);
        if (!member) {
          emitResult(ctx, `squad_code: unknown member "${slug}"`, true);
          return;
        }
        if (member.status !== "active") {
          emitResult(ctx, `squad_code: member "${slug}" is not active`, true);
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
        const result = await runCodeTurn({
          runAgentTurn: turnSeam,
          membersRoot: membersDir(),
          member,
          project: { name: resolved.project.name, rootPath: resolved.project.rootPath },
          task,
          abortSignal: ctx.abortSignal,
        });
        if (!result.ok) {
          emitResult(ctx, `squad_code: ${result.error}`, true);
          return;
        }
        emitResult(
          ctx,
          summarizeCode(member, resolved.project.name, result.outcome),
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
        let project: { id: string; name: string; rootPath: string } | undefined;
        const selector = asNonEmptyString(parsed.data.project);
        if (selector) {
          if (!projectsSeam) {
            emitResult(ctx, "squad_coordinate: projects seam unavailable on this harness", true);
            return;
          }
          const resolved = resolveProject(projectsSeam(), selector);
          if (!resolved.ok) {
            emitResult(ctx, `squad_coordinate: ${resolved.error}`, true);
            return;
          }
          project = {
            id: resolved.project.id,
            name: resolved.project.name,
            rootPath: resolved.project.rootPath,
          };
        }
        const active = (await readMembers(membersDir())).filter((m) => m.status === "active");
        const wanted = requested && requested.length > 0 ? new Set(requested) : undefined;
        const roster = wanted ? active.filter((m) => wanted.has(m.slug)) : active;
        if (roster.length === 0) {
          emitResult(ctx, "squad_coordinate: no matching active members to coordinate", true);
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
          membersRoot: membersDir(),
          dataHome: squadDataHome(),
          roster,
          task,
          ...(normalizedManagerProvider ? { managerProvider: normalizedManagerProvider } : {}),
          ...(coherentManagerModel ? { managerModel: coherentManagerModel } : {}),
          abortSignal: ctx.abortSignal,
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
  ],

  // The Squad nav tab. The roster sits in the header (the members you author); each
  // member is a card with Enter / Set model / Retire. No static actions[]: a
  // payload-less button can't carry input, so genesis is the squad-genesis workflow
  // and the card verbs are payload-carrying board actions that reach onAction.
  surfaces: [
    {
      id: SQUAD_SURFACE_ID,
      title: "Squad",
      subtitle: "Author members · talk to your team",
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
                key: DECISIONS_KEY,
                workflow: "squad-decisions",
                title: "Decisions",
                // NO cadenceMs by design: squad-decisions runs a paid agent turn to
                // render the recalled ledger, so a heartbeat would burn turns idle.
                // Client SWR refreshes it on open/focus (the region has no cadence);
                // re-open the panel after recording a decision to see it. A self-
                // gating, cost-bounded refresh (chamber-digest style) is Phase 3.
                collapsible: true,
                glyph: { char: "§", tone: "accent" },
              },
            ],
          },
          {
            columns: [
              {
                key: CAST_KEY,
                workflow: "squad-cast",
                title: "Proposed squad",
                // NO cadenceMs: the cast collector only changes on propose/approve/
                // discard, so a heartbeat would just re-render the idle board. The
                // propose action publishes it via refreshWorkflow and opens it in the
                // drawer; collapsed by default so an empty panel doesn't clutter.
                collapsible: true,
                collapsed: true,
                glyph: { char: "✦", tone: "brand" },
              },
            ],
          },
          {
            columns: [
              {
                key: COORDINATOR_KEY,
                workflow: "squad-coordinator",
                title: "Run loop",
                // NO cadenceMs: the collector reads a static ledger file, so a heartbeat
                // would re-render an unchanged board between runs. squad_coordinate refreshes
                // it on completion via refreshWorkflow; collapsed by default until a run lands.
                collapsible: true,
                collapsed: true,
                glyph: { char: "↻", tone: "info" },
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
    return [
      makeEmitMemberTool(ctx.refreshWorkflow),
      makeListMembersTool(),
      makeRetireMemberTool(ctx.refreshWorkflow),
      makeRememberTool(),
      makeDispatchTool(ctx.runAgentTurn),
      makeCodeTool(ctx.runAgentTurn, ctx.getProjects),
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
    switch (action.type) {
      case "enter-member":
        return enterMemberAction(action);
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
      case RECORD_DECISION_ACTION:
        return recordDecisionAction(action);
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
    const member = (await readMembers(membersDir())).find((m) => m.slug === slug);
    if (!member) return { ok: false, error: `unknown member: ${slug}` };
    const seed = await buildSeedFor(membersDir(), member);
    return { ok: true, data: { effect: "open-chat", seed } };
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

// Cast-propose: resolve a project, run ONE confined read-only repo-scan turn that
// auto-composes the roster, persist the proposal, refresh the Proposed-squad panel,
// and open it in the drawer. The scan is read-only and bounded to the project root
// inside proposeCast (cwd + allowedDirectories + read-only tools); scaffolding waits
// for approve. Fails closed when the agent-turn / projects seams are absent.
async function castProposeAction(action: RibAction): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  if (!runAgentTurn) {
    return { ok: false, error: "casting needs the agent-turn seam (unavailable on this harness)" };
  }
  if (!getProjects) {
    return { ok: false, error: "casting needs the projects seam (unavailable on this harness)" };
  }
  const resolved = resolveProject(getProjects(), asNonEmptyString(payload.project));
  if (!resolved.ok) return resolved;
  const missionRaw = asNonEmptyString(payload.mission);
  // A provider-listing hiccup must not block casting — degrade to unpinned members.
  let providers: ReturnType<NonNullable<RibContext["getProviders"]>> = [];
  try {
    providers = getProviders?.() ?? [];
  } catch {
    providers = [];
  }
  try {
    const result = await proposeCast({
      runAgentTurn,
      project: {
        id: resolved.project.id,
        name: resolved.project.name,
        rootPath: resolved.project.rootPath,
      },
      ...(missionRaw ? { mission: missionRaw.slice(0, MAX_MISSION_CHARS) } : {}),
      // Available-provider catalog so the scan can auto-assign each member's engine by
      // role (leaning overpowered). Absent seam / no providers → unpinned members.
      providers,
    });
    if (!result.ok) return { ok: false, error: result.error };
    await writeProposal(squadDataHome(), result.proposal);
    await refreshWorkflow?.("squad-cast");
    return { ok: true, data: { effect: "open-canvas", key: CAST_KEY, title: "Proposed squad" } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Approve-cast: theme each proposed member (the shared casting intercept) and
// scaffold them (collision-safe — an existing slug is kept, never clobbered;
// member-capped with truncation surfaced), clear the proposal, and refresh the
// roster + cast panels. Reads the persisted proposal as the source of truth, so a
// stale board button can't approve a discarded proposal. Themed sequentially:
// each assignThemedIdentity reserves into the registry, so the next member draws a
// distinct character from the same ensemble.
async function approveCastAction(): Promise<RibActionResult> {
  try {
    const proposal = await readProposal(squadDataHome());
    if (!proposal) return { ok: false, error: "no proposal to approve — cast a squad first" };
    const at = new Date().toISOString();
    const records: MemberRecord[] = [];
    for (const m of proposal.members) {
      records.push(
        await themedRecord({
          name: m.name,
          role: m.role,
          charter: m.charter,
          createdAt: at,
          ...(m.provider ? { provider: m.provider } : {}),
          ...(m.provider && m.model ? { model: m.model } : {}),
          ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
        }),
      );
    }
    const outcome = await scaffoldRoster(membersDir(), records);
    await clearProposal(squadDataHome());
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
    await clearProposal(squadDataHome());
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
    await setMemberModel(membersDir(), slug, { model, provider });
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
  try {
    await retireMember(membersDir(), slug);
    // Free the cast name so the ensemble can reuse it (fail-soft, never throws).
    await retireCastingName(squadDataHome(), slug);
    await refreshWorkflow?.("squad-roster")?.catch(() => {});
    return { ok: true, data: { slug } };
  } catch (e) {
    // retireMember throws when the dir is already gone, but a registry entry can linger
    // (a phantom reservation); free the cast name here too, same as the tool path.
    await retireCastingName(squadDataHome(), slug);
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

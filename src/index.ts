import { fileURLToPath } from "node:url";
import type {
  Rib,
  RibAction,
  RibActionResult,
  RibAuthStatus,
  RibContext,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { asNonEmptyString, errText, expectView, z } from "@keelson/shared";
import { listAgents, resolveAgent } from "./agents.ts";
import { buildSeedFor } from "./compose.ts";
import { type DispatchOutcome, dispatchFanout } from "./dispatch.ts";
import { slugify } from "./genesis.ts";
import { ROSTER_KEY, SQUAD_SURFACE_ID } from "./keys.ts";
import {
  type MemberRecord,
  readMembers,
  retireMember,
  scaffoldMember,
  setMemberModel,
} from "./member-store.ts";
import { isSquadDataHomeWritable, membersDir, setSquadDataHome, squadDataHome } from "./paths.ts";
import { GENESIS_STARTERS } from "./starters.ts";

// Seams captured in registerTools (the only hook with the full ctx) and cleared in
// dispose. refreshWorkflow re-runs the bound squad-roster collector after a
// mutation so the roster updates promptly instead of waiting on cadence;
// runAgentTurn backs squad_dispatch (the fan-out coordinator); getProjects is
// captured for later project-targeted work and only reported on in authStatus today.
let refreshWorkflow: RibContext["refreshWorkflow"];
let runAgentTurn: RibContext["runAgentTurn"];
let getProjects: RibContext["getProjects"];

// Absolute path to the roster collector, resolved at module load so the workflow
// node runs the right file regardless of the run's (nominal) cwd. fileURLToPath
// (not URL.pathname) decodes %20 etc. so an install path with a space resolves;
// it is shell-quoted where interpolated into the bash node below.
const ROSTER_COLLECTOR = fileURLToPath(new URL("../bin/collect-roster.ts", import.meta.url));

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
        const record: MemberRecord = {
          slug: slugify(name),
          name,
          role,
          charter,
          status: "active",
          createdAt: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(model && provider ? { provider } : {}),
          ...(dedupedTools.length > 0 ? { tools: dedupedTools } : {}),
        };
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
        await refresh?.("squad-roster");
        emitResult(ctx, JSON.stringify({ ok: true, slug: parsed.data.slug }));
      } catch (e) {
        emitResult(ctx, `squad_retire_member failed: ${errText(e)}`, true);
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

const rib: Rib = {
  id: "squad",
  displayName: "Squad",

  // Binds the roster key to the canvas renderer; data arrives when the squad-roster
  // collector runs.
  views: [{ key: ROSTER_KEY, canvasKind: "view", title: "Roster" }],

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
        rows: [],
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
  ],

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
    return [
      makeEmitMemberTool(ctx.refreshWorkflow),
      makeListMembersTool(),
      makeRetireMemberTool(ctx.refreshWorkflow),
      makeDispatchTool(ctx.runAgentTurn),
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
      case "set-model":
        return setModelAction(action);
      case "retire":
        return retireAction(action);
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
    await refreshWorkflow?.("squad-roster")?.catch(() => {});
    return { ok: true, data: { slug } };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export default rib;

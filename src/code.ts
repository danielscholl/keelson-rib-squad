import type { RibContext } from "@keelson/shared";
import { composeMemberSystemPrompt } from "./compose.ts";
import { runConfinedTurn, type TurnOutcome } from "./turn-runner.ts";
import type { Member } from "./types.ts";

// Code mode: a code-capable member runs ONE confined coding turn that actually edits
// the selected project's repository. This is the dev-loop primitive — the squad
// stops being a team you only talk to and starts doing the work. Built on the
// INJECTED runAgentTurn seam like cast.ts/dispatch.ts, so it is unit-testable against
// a fake. Unlike a dispatch turn (text-only) this turn has WRITE tools and is bounded
// to the project root (cwd + allowedDirectories), and unlike the read-only cast scan
// it may modify files. Integration (push/merge) is NOT its job — the squad's RAI
// floor (policies.ts) hard-denies merging and force-pushing from any agent turn.

// The code rail. allowedTools present means "these and no others" at the host (see
// apps/server rib-agent-turn.ts), so this enumerates the member's entire surface:
// Read/Glob/Grep to understand the repo, Edit/Write to change it, Bash to build and
// test locally — and nothing else.
export const CODE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;

// The capability tag a member must carry to run a code turn. The cast scan reserves
// "code" for true implementers; this is where that contract is enforced.
export const CODE_CAPABILITY = "code";

// Coding turns run longer than a read-only scan (build + test loops), so a wider
// ceiling than cast's 300s. Still bounded so a wedged provider can't run forever.
const DEFAULT_CODE_TIMEOUT_MS = 600_000;

export function memberCanCode(member: Pick<Member, "tools">): boolean {
  return member.tools?.includes(CODE_CAPABILITY) ?? false;
}

// The task framing rides in the prompt (the member's identity is the system prompt).
// It reinforces the RAI floor in prose — a soft nudge backing the hard policy deny —
// so a well-behaved member stops before integration even if the floor never fires.
function codePrompt(projectName: string, task: string): string {
  return `You are implementing a change in the project "${projectName}", working from its repository root. You have Read, Glob, Grep, Edit, Write, and Bash, confined to this project.

Make the change the task describes: edit files directly and run what you need to verify it locally (build, tests, type-check). Do NOT open, merge, or push a pull request, and do NOT force-push or rewrite history — the squad's review gate owns integration. When done, reply with a short summary of what you changed and how you verified it.

Task:
${task}`;
}

export interface RunCodeTurnOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  member: Member;
  project: { name: string; rootPath: string };
  task: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export type RunCodeTurnResult = { ok: true; outcome: TurnOutcome } | { ok: false; error: string };

// Run one confined coding turn for a member. Fails closed (never runs the turn) when
// the project has no root to confine to or the member is not code-capable — granting
// write tools and confining them are one decision, and an unbounded write turn is the
// thing we most need to refuse.
export async function runCodeTurn(opts: RunCodeTurnOptions): Promise<RunCodeTurnResult> {
  const root = opts.project.rootPath.trim();
  if (!root) {
    return { ok: false, error: `project "${opts.project.name}" has no root path to work in` };
  }
  if (!memberCanCode(opts.member)) {
    return {
      ok: false,
      error: `member "${opts.member.slug}" is not code-capable (needs the "${CODE_CAPABILITY}" tag)`,
    };
  }

  const system = await composeMemberSystemPrompt(opts.membersRoot, opts.member);
  const outcome = await runConfinedTurn(
    opts.runAgentTurn,
    {
      system,
      prompt: codePrompt(opts.project.name, opts.task),
      cwd: root,
      allowedDirectories: [root],
      allowedTools: [...CODE_TOOLS],
      // The member's pinned coordinates, honored per call — this is the mixed-provider
      // story (a Claude coder, a Codex coder) the original squad can't have. provider
      // only rides alongside a model (the store's coherence rule).
      ...(opts.member.model ? { model: opts.member.model } : {}),
      ...(opts.member.model && opts.member.provider ? { provider: opts.member.provider } : {}),
    },
    opts.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
    opts.abortSignal,
  );
  return { ok: true, outcome };
}

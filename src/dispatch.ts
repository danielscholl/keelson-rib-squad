import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RibContext, RibExec, TokenUsage } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { composeMemberSystemPrompt } from "./compose.ts";
import { MEMORY_DOC_CAP, readMemberDoc, writeMemory } from "./member-store.ts";
import { runConfinedTurn, type ToolTrace } from "./turn-runner.ts";
import { type Member, normalizeToolAllowlist } from "./types.ts";

// The fan-out coordinator: one turn per member in parallel, then one synthesis
// turn over their replies. Built on an INJECTED runAgentTurn (the host seam), not
// an imported host, so the mechanism is unit-testable against a fake. Turns are
// text-only by default; a project-bound wave grants each member READ_TOOLS confined
// to the repo root so a reviewer can actually inspect what it is asked to judge.

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_MEMBERS = 6;
const execFileAsync = promisify(execFile);

// A reviewer turn's context is finite; an unbounded diff (a big refactor, a regenerated
// lockfile) blows it and buries the signal the review is meant to catch. Cap the assembled
// review diff and tell the reviewer to open files directly (it has READ_TOOLS) for the rest.
const MAX_REVIEW_DIFF_CHARS = 24_000;
// Part of the budget reserved for the untracked (new-file) section, capped independently of
// the tracked diff. New files are absent from `git diff` entirely, so a large tracked diff
// must never be able to truncate the whole new-file section away — that would re-hide exactly
// what the untracked-visibility fix surfaces, in the large-change case the cap targets.
const UNTRACKED_DIFF_BUDGET = 8_000;
// A scaffold can drop dozens of new files at once; diffing every one would crowd out the
// tracked changes. List the overflow by count instead of diffing all of them.
const MAX_UNTRACKED_FILES = 25;
// git's own ceiling on a single diff read — the existing tracked-diff bound, reused for the
// untracked enumeration and per-file new-file diffs.
const GIT_DIFF_MAX_BUFFER = 10 * 1024 * 1024;

export interface DiffCaptureOptions {
  exec?: RibExec;
  baselineTree?: string;
}

// The read rail for a project-bound dispatch: enough to inspect the repo (the read subset
// of code.ts's CODE_TOOLS), and nothing that mutates it. allowedTools present means "these
// and no others" at the host, so a dispatched member can ground its answer in real files but
// cannot edit, run commands, or push — those stay the code arm's job, behind the RAI floor.
export const READ_TOOLS = ["Read", "Glob", "Grep"] as const;

export type DispatchStatus = "ok" | "error" | "timeout" | "aborted";

export interface DispatchResult {
  slug: string;
  name: string;
  status: DispatchStatus;
  text: string;
  error?: string;
  // The provider id the host resolved this member's turn to — for "contributed by X" provenance.
  providerId?: string;
  // Observability captured from the member's turn (#113).
  tools?: ToolTrace[];
  usage?: TokenUsage;
  durationMs?: number;
}

export interface DispatchOutcome {
  task: string;
  perMember: DispatchResult[];
  synthesis?: string;
  // Truncation, synthesis-skip, and synthesis-failure are surfaced here, never
  // silently dropped.
  notes: string[];
  // Wave-total token usage: every member turn plus the synthesis turn, summed.
  // Absent when no turn reported usage.
  usage?: TokenUsage;
}

export interface DispatchFanoutOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  members: Member[];
  task: string;
  // When set, each member's turn gets READ_TOOLS confined to the project root (cwd +
  // allowedDirectories) so it can inspect the repo to answer — a reviewer that can't read
  // the diff is useless. Absent keeps the turn text-only (pure reasoning, no filesystem).
  project?: { name: string; rootPath: string };
  // When the caller KNOWS this is a review (the coordinator's deterministic review gate),
  // set true to force diff capture + adversarial framing regardless of how the instruction
  // reads. Omit to fall back to sniffing the task text (an ad-hoc manager-directed review).
  isReview?: boolean;
  // When present, review diff capture scopes to the run's durable baseline tree instead of the
  // operator's whole working-tree state. The exec seam lets the scratch-index tree mirror the
  // coordinator's run-delta capture path.
  baselineTree?: string;
  exec?: RibExec;
  concurrency?: number;
  perTurnTimeoutMs?: number;
  maxMembers?: number;
  synthesize?: boolean;
  // The member that authors the synthesis turn; absent runs a generic synthesis
  // with no charter.
  synthesizer?: Member;
  // Opt-in post-wave reflection: after the wave, each member that returned a
  // substantive answer runs ONE more (paid) turn to curate its own memory.md from
  // what it just learned. OFF by default — it DOUBLES the per-member turn cost, so
  // normal dispatch is unchanged unless a caller asks for it.
  reflect?: boolean;
  abortSignal?: AbortSignal;
}

// Total cost is (capped members) + 1 turn when synthesis runs — one billed
// provider call per dispatched member, plus the synthesizer.
export async function dispatchFanout(opts: DispatchFanoutOptions): Promise<DispatchOutcome> {
  const notes: string[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const maxMembers = Math.max(1, opts.maxMembers ?? DEFAULT_MAX_MEMBERS);

  let members = opts.members;
  if (members.length > maxMembers) {
    notes.push(`truncated to ${maxMembers} of ${members.length} members (cost cap)`);
    members = members.slice(0, maxMembers);
  }

  // Default synthesis on for a multi-member wave, off for a single member (its one
  // reply IS the answer — a synthesis turn there is a redundant paid call). An explicit
  // `synthesize` still wins. Computed AFTER truncation so a cost-capped 1-member wave
  // skips it too.
  const wantSynthesis = opts.synthesize ?? members.length > 1;

  const root = opts.project?.rootPath.trim();
  const reviewDiffUnderReview = await captureDiffUnderReview(
    opts.task,
    opts.project,
    opts.isReview,
    {
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.baselineTree ? { baselineTree: opts.baselineTree } : {}),
    },
  );
  const perMember = await runPool(members, concurrency, async (member): Promise<DispatchResult> => {
    if (opts.abortSignal?.aborted) {
      return { slug: member.slug, name: member.name, status: "aborted", text: "" };
    }
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const toolAllowlist = normalizeToolAllowlist(member.toolAllowlist);
    const outcome = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildDispatchPrompt(opts.task, opts.project, reviewDiffUnderReview),
        ...(root ? { cwd: root, allowedDirectories: [root], allowedTools: [...READ_TOOLS] } : {}),
        ...(root && toolAllowlist ? { tools: toolAllowlist.map((name) => ({ name })) } : {}),
        ...(member.provider ? { provider: member.provider } : {}),
        ...(member.provider && member.model ? { model: member.model } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    return { slug: member.slug, name: member.name, ...outcome };
  });

  const oks = perMember.filter((r) => r.status === "ok" && r.text.trim().length > 0);
  let synthesis: string | undefined;
  let synthesisUsage: TokenUsage | undefined;
  if (!wantSynthesis) {
    if (oks.length === 0 && opts.abortSignal?.aborted) {
      notes.push("synthesis skipped — dispatch aborted");
    } else if (oks.length === 0) {
      notes.push(`no usable member reply — ${perMember.length} member turn(s) failed`);
    } else {
      notes.push("synthesis skipped (disabled)");
    }
  } else if (oks.length === 0) {
    notes.push("synthesis skipped — no member returned a usable result");
  } else if (opts.abortSignal?.aborted) {
    notes.push("synthesis skipped — dispatch aborted");
  } else {
    const synthSystem = opts.synthesizer
      ? await composeMemberSystemPrompt(opts.membersRoot, opts.synthesizer)
      : GENERIC_SYNTH_SYSTEM;
    const outcome = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system: synthSystem,
        prompt: buildSynthesisPrompt(opts.task, oks),
        // Grant the synthesizer the same project-bound read rail the members got, so a review
        // synthesis can independently confirm a cited defect (read the file:line) before
        // upholding a BLOCK instead of synthesizing blind from the members' claims (#63).
        ...(root ? { cwd: root, allowedDirectories: [root], allowedTools: [...READ_TOOLS] } : {}),
        ...(opts.synthesizer?.provider ? { provider: opts.synthesizer.provider } : {}),
        ...(opts.synthesizer?.provider && opts.synthesizer.model
          ? { model: opts.synthesizer.model }
          : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status === "ok") {
      synthesis = outcome.text;
      synthesisUsage = outcome.usage;
    } else {
      notes.push(
        `synthesis turn ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""} — returning per-member results only`,
      );
    }
  }

  // Post-wave reflection (opt-in). Runs after synthesis so a reflection turn never
  // delays the answer's assembly; each member curates its own memory from its own
  // reply. Gated, fail-closed — a member with no substance, or a reflection that
  // errors/empties/over-caps, leaves the prior memory standing.
  if (opts.reflect) {
    await reflectMembers(opts, members, perMember, concurrency, perTurnTimeoutMs, notes);
  }

  const usage = sumUsage([...perMember.map((r) => r.usage), synthesisUsage]);
  return {
    task: opts.task,
    perMember,
    ...(synthesis !== undefined ? { synthesis } : {}),
    notes,
    ...(usage ? { usage } : {}),
  };
}

// Sum the defined usages into a wave total; undefined when no turn reported one.
function sumUsage(usages: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const u of usages) {
    if (!u) continue;
    seen = true;
    input += u.inputTokens;
    output += u.outputTokens;
  }
  return seen ? { inputTokens: input, outputTokens: output } : undefined;
}

// One reflection turn per member that produced substance, bounded by the same pool
// width as the wave. Each member is distinct, so the turns run in parallel — no
// per-member serialization is needed (unlike chamber, where concurrent room closes
// can target one Mind). The reflection's full reply IS the new memory document;
// writeMemory caps it. Every skip/failure is surfaced as a note, never silent.
async function reflectMembers(
  opts: DispatchFanoutOptions,
  members: readonly Member[],
  perMember: readonly DispatchResult[],
  concurrency: number,
  perTurnTimeoutMs: number,
  notes: string[],
): Promise<void> {
  if (opts.abortSignal?.aborted) {
    notes.push("reflection skipped — dispatch aborted");
    return;
  }
  // Members and perMember are index-aligned (perMember is built from `members`
  // in order, after truncation), so zip them to pair each reply with its author.
  const reflectors = members
    .map((member, i) => ({ member, result: perMember[i] }))
    .filter(
      (r): r is { member: Member; result: DispatchResult } =>
        r.result?.status === "ok" && r.result.text.trim().length > 0,
    );
  if (reflectors.length === 0) {
    notes.push("reflection skipped — no member produced substance");
    return;
  }

  await runPool(reflectors, concurrency, async ({ member, result }) => {
    if (opts.abortSignal?.aborted) return;
    const prior = (await readMemberDoc(opts.membersRoot, member.slug, "memory.md")) ?? "";
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildReflectionPrompt(member, opts.task, result.text, prior),
        allowedTools: [],
        ...(member.provider ? { provider: member.provider } : {}),
        ...(member.provider && member.model ? { model: member.model } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status !== "ok") {
      notes.push(
        `reflection for ${member.slug} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""} — prior memory kept`,
      );
      return;
    }
    const next = outcome.text.trim();
    if (next.length === 0) {
      notes.push(`reflection for ${member.slug} returned empty — prior memory kept`);
      return;
    }
    // A shutdown landing during the (paid) turn drops the late write (mirrors the
    // chamber reflection gate) so a disposing run can't resurrect memory.
    if (opts.abortSignal?.aborted) return;
    try {
      await writeMemory(opts.membersRoot, member.slug, next);
      notes.push(`reflection updated ${member.slug} memory`);
    } catch (e) {
      // Over-cap / unsafe / missing — fail closed: the prior memory stands.
      notes.push(`reflection for ${member.slug} not persisted (${errText(e)}) — prior memory kept`);
    }
  });
}

// One participating member paired with everything it contributed across a completed run —
// the substance a loop-close reflection curates its memory from.
export interface MemberContribution {
  member: Member;
  contribution: string;
}

export interface ReflectAtCloseOptions {
  runAgentTurn: NonNullable<RibContext["runAgentTurn"]>;
  membersRoot: string;
  task: string;
  contributions: readonly MemberContribution[];
  concurrency?: number;
  perTurnTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

// Loop-close reflection: each member that did substantive work in a COMPLETED run curates
// its own memory.md ONCE, over its whole contribution — the issue #2 boundary-gated cadence,
// distinct from dispatch's per-wave `reflect` (which would multiply paid turns every round).
// Members are distinct so the (paid) turns run in a bounded pool; fail-closed per member (an
// aborted/errored/empty/over-cap reflection leaves the prior memory). Returns the slugs whose
// memory was updated.
export async function reflectMembersAtClose(opts: ReflectAtCloseOptions): Promise<string[]> {
  if (opts.abortSignal?.aborted) return [];
  const reflectors = opts.contributions.filter((c) => c.contribution.trim().length > 0);
  if (reflectors.length === 0) return [];
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const perTurnTimeoutMs = opts.perTurnTimeoutMs ?? DEFAULT_PER_TURN_TIMEOUT_MS;
  const updated: string[] = [];
  await runPool(reflectors, concurrency, async ({ member, contribution }) => {
    if (opts.abortSignal?.aborted) return;
    const prior = (await readMemberDoc(opts.membersRoot, member.slug, "memory.md")) ?? "";
    const system = await composeMemberSystemPrompt(opts.membersRoot, member);
    const outcome = await runConfinedTurn(
      opts.runAgentTurn,
      {
        system,
        prompt: buildReflectionPrompt(member, opts.task, contribution, prior),
        allowedTools: [],
        ...(member.provider ? { provider: member.provider } : {}),
        ...(member.provider && member.model ? { model: member.model } : {}),
      },
      perTurnTimeoutMs,
      opts.abortSignal,
    );
    if (outcome.status !== "ok") return;
    const next = outcome.text.trim();
    if (next.length === 0) return;
    // A shutdown landing during the (paid) turn drops the late write, so a disposing run
    // can't resurrect memory (mirrors the per-wave reflect gate).
    if (opts.abortSignal?.aborted) return;
    try {
      await writeMemory(opts.membersRoot, member.slug, next);
      updated.push(member.slug);
    } catch {
      // Over-cap / unsafe / missing — fail closed: the prior memory stands.
    }
  });
  return updated;
}

// The reflection doctrine, mirrored from chamber: curate (don't summarize), a high
// bar for what persists, decontextualize, and CONSOLIDATE the whole document so
// pruning is in-band rather than a blind append. The reply is the COMPLETE new
// memory (plain Markdown — no tool, no JSON), written to the member it reflects for.
function buildReflectionPrompt(
  member: Member,
  task: string,
  reply: string,
  priorMemory: string,
): string {
  const role = member.role?.trim() ? member.role.trim() : "member";
  return `You are ${member.name}. You just answered a task dispatched to your squad. Curate your long-term memory before moving on.

You are NOT summarizing the task. Decide what — if anything — your future self should carry into a DIFFERENT task. Most of this belongs to this task alone and should be forgotten. Persist only what would make you a sharper ${role} weeks from now: a durable fact about the project, the operator, or the domain; or a lesson about how you work. When unsure, keep nothing. Do NOT restate your charter — identity is not memory.

The task you answered:
---
${task}
---

Your answer:
---
${reply}
---

Your CURRENT memory:
---
${priorMemory.trim() || "(empty)"}
---

Return the COMPLETE updated memory document (Markdown), not an addition. For each existing item: keep it, sharpen it, fold this task's learning into it, or DELETE it if it is now wrong or stale. Then add only genuinely new durable facts. Merge near-duplicates. Keep the whole document under ${MEMORY_DOC_CAP} characters. Write every item so a future you with no memory of this task understands it alone (name who/what/when with absolute dates).

Reply with ONLY the memory document text and nothing else. To change nothing, return your current memory verbatim. Writing nothing new is the common, correct outcome.`;
}

// Frame a project-bound member turn so it knows it can (and should) read the repo to ground
// its answer rather than guess at file contents — the read tools are useless if the member
// doesn't reach for them. Text-only turns pass the task through unchanged.
function buildDispatchPrompt(
  task: string,
  project?: { name: string; rootPath: string },
  reviewDiffUnderReview?: string,
): string {
  if (!project?.rootPath.trim()) return task;
  const reviewContext = reviewDiffUnderReview
    ? `\n\n## CODE DIFF UNDER REVIEW\n${reviewDiffUnderReview}\n\n## ADVERSARIAL REVIEW MODE (REFUTE BY DEFAULT)\nTreat this as an adversarial code review. Assume the change is incorrect until proven otherwise.\n\nBefore concluding, explicitly try to refute the change by checking:\n1. Every new or changed constant, bound, or enum value against existing defaults in the same module; flag mismatched defaults, incompatible bounds, and off-by-one ranges.\n2. Any function that returns a shared mutable object (array/object/map/set) by reference instead of returning an immutable/defensive copy.\n\nIf you find a real defect, cite exact file:line evidence and signal it with the existing BLOCK sentinel: RAI VERDICT: BLOCK.`
    : "";
  return `You are working in the project "${project.name}", at its repository root. You have Read, Glob, and Grep to inspect the repo — open the files you need to ground your answer instead of guessing at their contents. This is a read-only analysis/review turn: you cannot edit, run commands, or push.

${reviewContext}

${task}`;
}

function isProjectReviewTask(task: string): boolean {
  const t = task.toLowerCase();
  return /\breview\b|\badversarial\b|\baudit\b|\binspect\b/.test(t);
}

export async function captureDiffUnderReview(
  task: string,
  project?: { name: string; rootPath: string },
  isReview?: boolean,
  optionsOrExec?: RibExec | DiffCaptureOptions,
): Promise<string | undefined> {
  const root = project?.rootPath.trim();
  if (!root) return undefined;
  // An explicit `isReview` from the coordinator's deterministic review gate is authoritative:
  // the gate must capture the diff regardless of how the instruction is phrased. Only fall
  // back to sniffing the task text when the caller didn't say (an ad-hoc dispatch step).
  const review = isReview ?? isProjectReviewTask(task);
  if (!review) return undefined;
  return await collectGitDiff(root, normalizeDiffCaptureOptions(optionsOrExec));
}

function normalizeDiffCaptureOptions(optionsOrExec?: RibExec | DiffCaptureOptions): DiffCaptureOptions {
  if (!optionsOrExec) return {};
  if ("runText" in optionsOrExec) return { exec: optionsOrExec };
  return optionsOrExec;
}

async function collectGitDiff(rootPath: string, options: DiffCaptureOptions = {}): Promise<string> {
  const baselineTree = options.baselineTree?.trim();
  if (baselineTree) return await collectBaselineScopedGitDiff(rootPath, baselineTree, options.exec);

  const exec = options.exec;
  const [unstaged, staged, untracked, unstagedNumstat, stagedNumstat] = await Promise.all([
    readGitDiff(rootPath, [], exec),
    readGitDiff(rootPath, ["--staged"], exec),
    readUntrackedDiff(rootPath, exec),
    readGitDiff(rootPath, ["--numstat"], exec),
    readGitDiff(rootPath, ["--staged", "--numstat"], exec),
  ]);
  const binaryPaths = new Set<string>([
    ...(unstagedNumstat.kind === "ok" ? parseBinaryNumstatPaths(unstagedNumstat.output) : []),
    ...(stagedNumstat.kind === "ok" ? parseBinaryNumstatPaths(stagedNumstat.output) : []),
  ]);
  // A brand-new file never appears in `git diff` (tracked) — exactly the change a review most
  // needs to see, so the untracked section gets its own reserved budget below.
  const tracked: string[] = [];
  if (unstaged.kind === "ok" && unstaged.output.trim().length > 0) {
    const partitioned = partitionBinaryDiff(unstaged.output, binaryPaths);
    addBinaryPaths(binaryPaths, partitioned.binaryPaths);
    if (partitioned.output.trim().length > 0) {
      tracked.push(`### Working tree\n\`\`\`diff\n${partitioned.output.trimEnd()}\n\`\`\``);
    }
  }
  if (staged.kind === "ok" && staged.output.trim().length > 0) {
    const partitioned = partitionBinaryDiff(staged.output, binaryPaths);
    addBinaryPaths(binaryPaths, partitioned.binaryPaths);
    if (partitioned.output.trim().length > 0) {
      tracked.push(`### Staged\n\`\`\`diff\n${partitioned.output.trimEnd()}\n\`\`\``);
    }
  }
  if (untracked) addBinaryPaths(binaryPaths, untracked.binaryPaths);

  if (tracked.length === 0 && !untracked?.section && binaryPaths.size === 0) {
    if (unstaged.kind === "error") return `_Diff capture unavailable: ${unstaged.error}_`;
    if (staged.kind === "error") return `_Diff capture unavailable: ${staged.error}_`;
    return "_No staged, unstaged, or untracked changes detected in the project working tree._";
  }

  // Cap the two sections INDEPENDENTLY, never a single cap over the joined string: with one
  // shared cap that truncates from the front, a large tracked diff drops the whole untracked
  // section (names included), re-hiding the new files this very change set out to surface.
  // The untracked section keeps a guaranteed slice (names lead, so they survive); the tracked
  // diff takes whatever budget remains so the total still fits the review turn.
  const untrackedSection = untracked?.section
    ? capDiffSection(untracked.section, UNTRACKED_DIFF_BUDGET, "new-file diff")
    : "";
  const binarySection = formatBinaryAppendix(binaryPaths);
  const trackedBudget = Math.max(
    0,
    MAX_REVIEW_DIFF_CHARS - untrackedSection.length - binarySection.length,
  );
  const trackedSection =
    tracked.length > 0 ? capDiffSection(tracked.join("\n\n"), trackedBudget, "tracked diff") : "";
  return [trackedSection, untrackedSection, binarySection]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function collectBaselineScopedGitDiff(
  rootPath: string,
  baselineTree: string,
  exec?: RibExec,
): Promise<string> {
  const current = await captureCurrentTree(rootPath, exec);
  if (current.kind === "error") return `_Diff capture unavailable: ${current.error}_`;

  const nameStatus = await runGitText(
    rootPath,
    ["diff", "--name-status", "--find-renames", baselineTree, current.tree],
    exec,
  );
  if (nameStatus.kind === "error") return `_Diff capture unavailable: ${nameStatus.error}_`;
  if (nameStatus.output.trim().length === 0) {
    return "_No changes detected since the run baseline._";
  }

  const numstat = await runGitText(
    rootPath,
    ["diff", "--numstat", "--find-renames", baselineTree, current.tree],
    exec,
  );
  if (numstat.kind === "error") return `_Diff capture unavailable: ${numstat.error}_`;
  const binaryPaths = new Set(parseBinaryNumstatPaths(numstat.output));
  const entries = parseNameStatus(nameStatus.output);
  const addedPaths = entries
    .filter((entry) => entry.status === "A")
    .map((entry) => entry.paths[0])
    .filter(
      (path): path is string =>
        typeof path === "string" && path.length > 0 && !binaryPaths.has(path),
    );
  const [changed, added] = await Promise.all([
    readGitDiff(rootPath, ["--find-renames", "--diff-filter=a", baselineTree, current.tree], exec),
    readAddedFileDiff(rootPath, baselineTree, current.tree, addedPaths, exec),
  ]);
  if (changed.kind === "error") return `_Diff capture unavailable: ${changed.error}_`;
  const partitionedChanged = partitionBinaryDiff(changed.output, binaryPaths);
  addBinaryPaths(binaryPaths, partitionedChanged.binaryPaths);
  addBinaryPaths(binaryPaths, added.binaryPaths);

  const statusSection = `### Run delta (baseline-scoped)\nChanged paths since the run baseline:\n\`\`\`diff\n${nameStatus.output.trimEnd()}\n\`\`\``;
  const addedSection = added.section
    ? capDiffSection(added.section, UNTRACKED_DIFF_BUDGET, "added-file diff")
    : "";
  const changedBody =
    partitionedChanged.output.trim().length > 0
      ? `### Changed/deleted content\n\`\`\`diff\n${partitionedChanged.output.trimEnd()}\n\`\`\``
      : "";
  const binarySection = formatBinaryAppendix(binaryPaths);
  const changedBudget = Math.max(
    0,
    MAX_REVIEW_DIFF_CHARS - statusSection.length - addedSection.length - binarySection.length,
  );
  const changedSection = changedBody
    ? capDiffSection(changedBody, changedBudget, "run-delta diff")
    : "";

  return [statusSection, changedSection, addedSection, binarySection]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function captureCurrentTree(
  rootPath: string,
  exec?: RibExec,
): Promise<{ kind: "ok"; tree: string } | { kind: "error"; error: string }> {
  const scratchDir = await mkdtemp(join(tmpdir(), "squad-review-delta-"));
  const env = { GIT_INDEX_FILE: join(scratchDir, "index") };
  try {
    const staged = await runGitText(rootPath, ["add", "-A", "--", "."], exec, { env });
    if (staged.kind === "error") return staged;
    const tree = await runGitText(rootPath, ["write-tree"], exec, { env });
    if (tree.kind === "error") return tree;
    const oid = tree.output.trim();
    if (!oid) return { kind: "error", error: "git write-tree returned an empty tree id" };
    return { kind: "ok", tree: oid };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

interface NameStatusEntry {
  status: string;
  paths: string[];
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split("\t");
    if (status && paths.length > 0) entries.push({ status, paths });
  }
  return entries;
}

interface DiffSectionResult {
  section?: string;
  binaryPaths: string[];
}

async function readAddedFileDiff(
  rootPath: string,
  baselineTree: string,
  currentTree: string,
  files: readonly string[],
  exec?: RibExec,
): Promise<DiffSectionResult> {
  if (files.length === 0) return { binaryPaths: [] };
  const shown = files.slice(0, MAX_UNTRACKED_FILES);
  const overflow = files.length - shown.length;
  const names = shown.map((f) => `- \`${f}\``).join("\n");
  const overflowNote = overflow > 0 ? `\n- _…and ${overflow} more new file(s) not shown_` : "";
  const diffs: string[] = [];
  const binaryPaths: string[] = [];
  for (const f of shown) {
    const body = await readDeltaFileDiff(rootPath, baselineTree, currentTree, f, exec);
    if (body && body.trim().length > 0) {
      const partitioned = partitionBinaryDiff(body, new Set<string>());
      if (partitioned.binaryPaths.length > 0) {
        binaryPaths.push(...partitioned.binaryPaths);
      }
      if (partitioned.output.trim().length > 0) {
        diffs.push(`#### \`${f}\`\n\`\`\`diff\n${partitioned.output.trimEnd()}\n\`\`\``);
      }
    }
  }
  const diffBlock = diffs.length > 0 ? `\n\n${diffs.join("\n\n")}` : "";
  return {
    section: `### Added files\nNew files created since the run baseline:\n${names}${overflowNote}${diffBlock}`,
    binaryPaths,
  };
}

async function readDeltaFileDiff(
  rootPath: string,
  baselineTree: string,
  currentTree: string,
  relPath: string,
  exec?: RibExec,
): Promise<string | undefined> {
  const result = await readGitDiff(
    rootPath,
    ["--find-renames", baselineTree, currentTree, "--", relPath],
    exec,
  );
  return result.kind === "ok" ? result.output : undefined;
}

// Bound one diff section so content + the truncation note together stay within `budget` — one
// large change can't blow the reviewer's context, and the budgets actually hold (the note's own
// length comes out of the budget, not on top of it). Closes any open ```diff fence and names
// what was cut; the reviewer keeps READ_TOOLS, so the note points it at the files for the rest.
function capDiffSection(diff: string, budget: number, label: string): string {
  if (diff.length <= budget) return diff;
  const note = (omitted: number): string =>
    `\n\`\`\`\n\n_[${label} truncated — ${omitted} more character(s) omitted to fit the review turn; open the files directly with Read/Glob/Grep to review the rest.]_`;
  // Reserve the note's worst-case length (omitting the whole diff) so the returned string never
  // exceeds budget; the actual note is no longer than that reservation.
  const keep = Math.max(0, budget - note(diff.length).length);
  return `${diff.slice(0, keep)}${note(diff.length - keep)}`;
}

function addBinaryPaths(target: Set<string>, paths: readonly string[]): void {
  for (const path of paths) {
    const normalized = path.trim();
    if (normalized) target.add(normalized);
  }
}

function formatBinaryAppendix(paths: ReadonlySet<string>): string {
  if (paths.size === 0) return "";
  const names = [...paths].sort().map((path) => `- \`${path}\``);
  return `### Binary files changed (not shown)\n${names.join("\n")}`;
}

function parseBinaryNumstatPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts[0] === "-" && parts[1] === "-") {
      const path = parts.slice(2).join("\t").trim();
      if (path) paths.push(path);
    }
  }
  return paths;
}

function partitionBinaryDiff(
  output: string,
  knownBinaryPaths: ReadonlySet<string>,
): { output: string; binaryPaths: string[] } {
  const kept: string[] = [];
  const binaryPaths: string[] = [];
  for (const block of splitDiffBlocks(output)) {
    const path = pathFromBinaryMarker(block) ?? pathFromDiffHeader(block);
    const hasBinaryMarker = /^Binary files .+ differ$/m.test(block);
    if (path && (hasBinaryMarker || knownBinaryPaths.has(path))) {
      binaryPaths.push(path);
      continue;
    }
    kept.push(block);
  }
  return { output: kept.join("\n"), binaryPaths };
}

function splitDiffBlocks(output: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks.filter((block) => block.trim().length > 0);
}

function pathFromDiffHeader(block: string): string | undefined {
  const match = /^diff --git (.+) (.+)$/m.exec(block);
  if (!match) return undefined;
  return normalizeDiffPath(match[2]) ?? normalizeDiffPath(match[1]);
}

function pathFromBinaryMarker(block: string): string | undefined {
  const match = /^Binary files (.+) and (.+) differ$/m.exec(block);
  if (!match) return undefined;
  return normalizeDiffPath(match[2]) ?? normalizeDiffPath(match[1]);
}

function normalizeDiffPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let normalized = path.trim();
  if (normalized === "/dev/null") return undefined;
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return normalized.slice(2);
  }
  return normalized;
}

async function readGitDiff(
  rootPath: string,
  args: readonly string[],
  exec?: RibExec,
): Promise<{ kind: "ok"; output: string } | { kind: "error"; error: string }> {
  return await runGitText(rootPath, ["diff", "--no-color", ...args], exec);
}

async function runGitText(
  rootPath: string,
  args: readonly string[],
  exec?: RibExec,
  opts: { env?: Record<string, string> } = {},
): Promise<{ kind: "ok"; output: string } | { kind: "error"; error: string }> {
  if (exec) {
    const result = await exec.runText("git", [...args], {
      cwd: rootPath,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return result.ok ? { kind: "ok", output: result.data } : { kind: "error", error: result.error };
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootPath, "--no-pager", ...args], {
      maxBuffer: GIT_DIFF_MAX_BUFFER,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { kind: "ok", output: stdout };
  } catch (e) {
    return { kind: "error", error: errText(e) };
  }
}

// Enumerate untracked (and not gitignored) files and render each as a new-file diff. Uses
// `git diff --no-index` against /dev/null rather than `git add -N`: both make a new file show
// up in a diff, but --no-index is READ-ONLY and never mutates the operator's index. Returns
// undefined outside a git repo (the tracked-diff error already names that case).
async function readUntrackedDiff(
  rootPath: string,
  exec?: RibExec,
): Promise<DiffSectionResult | undefined> {
  let files: string[];
  if (exec) {
    const result = await exec.runText("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: rootPath,
    });
    if (!result.ok) return undefined;
    files = result.data.split("\0").filter((f) => f.length > 0);
  } else {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", rootPath, "ls-files", "--others", "--exclude-standard", "-z"],
        { maxBuffer: GIT_DIFF_MAX_BUFFER },
      );
      files = stdout.split("\0").filter((f) => f.length > 0);
    } catch {
      return undefined;
    }
  }
  if (files.length === 0) return undefined;
  const shown = files.slice(0, MAX_UNTRACKED_FILES);
  const overflow = files.length - shown.length;
  const names = shown.map((f) => `- \`${f}\``).join("\n");
  const overflowNote = overflow > 0 ? `\n- _…and ${overflow} more new file(s) not shown_` : "";
  const diffs: string[] = [];
  const binaryPaths: string[] = [];
  for (const f of shown) {
    const body = await readNewFileDiff(rootPath, f, exec);
    if (body && body.trim().length > 0) {
      const partitioned = partitionBinaryDiff(body, new Set<string>());
      if (partitioned.binaryPaths.length > 0) {
        binaryPaths.push(...partitioned.binaryPaths);
      }
      if (partitioned.output.trim().length > 0) {
        diffs.push(`#### \`${f}\`\n\`\`\`diff\n${partitioned.output.trimEnd()}\n\`\`\``);
      }
    }
  }
  const diffBlock = diffs.length > 0 ? `\n\n${diffs.join("\n\n")}` : "";
  return {
    section: `### Untracked (new) files\nNew files not yet tracked by git — they never appear in the tracked diffs above:\n${names}${overflowNote}${diffBlock}`,
    binaryPaths,
  };
}

async function readNewFileDiff(
  rootPath: string,
  relPath: string,
  exec?: RibExec,
): Promise<string | undefined> {
  if (exec) {
    const result = await exec.runText(
      "git",
      ["diff", "--no-color", "--no-index", "--", "/dev/null", relPath],
      {
        cwd: rootPath,
        acceptNonZeroExit: true,
      },
    );
    return result.ok ? result.data : undefined;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        rootPath,
        "--no-pager",
        "diff",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        relPath,
      ],
      { maxBuffer: GIT_DIFF_MAX_BUFFER },
    );
    // Identical to /dev/null (an empty new file) → exit 0, no diff body.
    return stdout;
  } catch (e) {
    // `git diff --no-index` exits 1 when the paths differ (always, for a non-empty new file);
    // its stdout still carries the diff. Any other exit is a real failure — drop that file.
    const err = e as { code?: unknown; stdout?: unknown };
    if (err.code === 1 && typeof err.stdout === "string") return err.stdout;
    return undefined;
  }
}

const GENERIC_SYNTH_SYSTEM =
  "You are a synthesis agent. You receive a task and several independent specialists' answers to it, and merge them into one coherent, non-redundant answer — reconciling agreement, surfacing disagreement, and attributing where it matters.";

function buildSynthesisPrompt(task: string, results: readonly DispatchResult[]): string {
  const sections = results.map((r) => `### ${r.name} (${r.slug})\n${r.text}`).join("\n\n");
  return `A task was dispatched to several squad members in parallel. Synthesize their independent responses into one coherent answer.\n\n## Task\n${task}\n\n## Member responses\n\n${sections}\n\n## Your job\nProduce a single synthesized answer to the task. Reconcile where they agree, note where they diverge, and do not merely concatenate them.`;
}

// A bounded async pool: at most `concurrency` workers in flight, each pulling the
// next index off a shared cursor. The worker is total (returns, never throws), so
// Promise.all gives Promise.allSettled isolation — one member's failure can't
// abort the wave. Results stay in member order.
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      const item = items[i];
      if (i >= items.length || item === undefined) break;
      results[i] = await worker(item);
    }
  };
  const lanes = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: lanes }, runner));
  return results;
}

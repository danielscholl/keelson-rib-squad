import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
} from "@keelson/shared";
import { dispatchFanout } from "../src/dispatch.ts";
import {
  type MemberRecord,
  readMemberDoc,
  scaffoldMember,
  writeMemory,
} from "../src/member-store.ts";
import type { Member } from "../src/types.ts";

// dispatchFanout takes the agent-turn seam as a parameter, so these drive it
// against a FAKE runAgentTurn — concurrency is asserted with an in-flight counter,
// never wall-clock. Members are scaffolded on disk so composeMemberSystemPrompt
// has real charters to read.

let root: string;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-dispatch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(slug: string, name: string): Promise<Member> {
  const record: MemberRecord = {
    slug,
    name,
    role: "Specialist",
    charter: `# ${name}\n\nI am ${name}.`,
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await scaffoldMember(root, record);
  return { slug, name, role: "Specialist", charter: `I am ${name}.`, status: "active" };
}

async function* oneChunkStream(text: string): AsyncGenerator<MessageChunk> {
  yield { type: "text", content: text };
  yield { type: "done" };
}

const okResult = (text: string): RibAgentTurnResult => ({ status: "ok", text });

function fakeTurn(result: Promise<RibAgentTurnResult>): RibAgentTurn {
  return { stream: oneChunkStream("x"), result };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function seedProjectRepoWithDiff(dirName: string): Promise<string> {
  const repo = join(root, dirName);
  await mkdir(repo, { recursive: true });
  const file = join(repo, "limits.ts");
  await writeFile(file, "export const DEFAULT_LIMIT = 10;\n");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Dispatch Test"], { cwd: repo });
  await execFileAsync("git", ["add", "limits.ts"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
  await writeFile(file, "export const DEFAULT_LIMIT = 11;\n");
  return repo;
}

describe("dispatchFanout", () => {
  test("routes each member's own provider/model into its turn (mixed-provider)", async () => {
    // A vendor-pinned triager (provider only, default model) and a fully-pinned reviewer.
    const triager = { ...(await seed("t", "Triager")), provider: "copilot" };
    const reviewer = {
      ...(await seed("r", "Reviewer")),
      provider: "claude",
      model: "claude-opus-4.8",
    };
    const seen = new Map<string, { provider?: string; model?: string }>();
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      const name = req.system?.match(/^# (.+)$/m)?.[1] ?? "?";
      seen.set(name, { provider: req.provider, model: req.model });
      return fakeTurn(Promise.resolve(okResult("ok")));
    };

    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members: [triager, reviewer],
      task: "T",
      synthesize: false,
    });

    // Provider-only member: the vendor is pinned, the model is left to its default.
    expect(seen.get("Triager")).toEqual({ provider: "copilot", model: undefined });
    // Fully-pinned member: both coordinates ride through to its own turn.
    expect(seen.get("Reviewer")).toEqual({ provider: "claude", model: "claude-opus-4.8" });
  });

  test("captures the served providerId on each member's result (provenance)", async () => {
    const triager = { ...(await seed("t", "Triager")), provider: "copilot" };
    const reviewer = { ...(await seed("r", "Reviewer")), provider: "claude" };
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      const name = req.system?.match(/^# (.+)$/m)?.[1] ?? "?";
      const providerId = name === "Triager" ? "copilot" : "claude";
      return fakeTurn(Promise.resolve({ status: "ok", text: "ok", providerId }));
    };
    const out = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members: [triager, reviewer],
      task: "T",
      synthesize: false,
    });
    expect(out.perMember.find((r) => r.slug === "t")?.providerId).toBe("copilot");
    expect(out.perMember.find((r) => r.slug === "r")?.providerId).toBe("claude");
  });

  test("fans out concurrently, bounded by `concurrency`", async () => {
    const members = await Promise.all([
      seed("a", "Alpha"),
      seed("b", "Beta"),
      seed("c", "Gamma"),
      seed("d", "Delta"),
      seed("e", "Echo"),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred<void>();
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = (async (): Promise<RibAgentTurnResult> => {
        await gate.promise;
        inFlight--;
        return okResult("ok");
      })();
      return fakeTurn(result);
    };

    const concurrency = 3;
    const p = dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      concurrency,
      synthesize: false,
    });

    // Hold the barrier until the pool has a full lane-width in flight — a counter
    // condition, not a timer. Bounded so a broken pool fails the assertion rather
    // than hanging.
    for (let i = 0; i < 500 && inFlight < concurrency; i++) await tick();
    expect(inFlight).toBe(concurrency);
    gate.resolve();

    const outcome = await p;
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(outcome.perMember).toHaveLength(5);
    expect(outcome.perMember.every((r) => r.status === "ok")).toBe(true);
  });

  test("isolates a failing member — the rest still resolve ok", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta"), seed("c", "Gamma")]);
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.system?.includes("Beta")) {
        return fakeTurn(
          (async (): Promise<RibAgentTurnResult> => {
            throw new Error("boom");
          })(),
        );
      }
      return fakeTurn(Promise.resolve(okResult("fine")));
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
    });
    const bySlug = Object.fromEntries(outcome.perMember.map((r) => [r.slug, r]));
    expect(bySlug.a?.status).toBe("ok");
    expect(bySlug.b?.status).toBe("error");
    expect(bySlug.b?.error).toContain("boom");
    expect(bySlug.c?.status).toBe("ok");
  });

  test("single-member wave with no usable reply records a failure note instead of synthesis skip", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn =>
      fakeTurn(Promise.resolve({ status: "error", text: "", error: "member blew up" }));

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
    });

    expect(outcome.perMember[0]?.status).toBe("error");
    expect(outcome.notes).toContain("no usable member reply — 1 member turn(s) failed");
    expect(outcome.notes).not.toContain("synthesis skipped (disabled)");
  });

  test("synthesis prompt carries every ok member's text", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta"), seed("c", "Gamma")]);
    const task = "Plan the launch";
    let synthPrompt: string | undefined;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt === task) {
        const name = req.system?.match(/^# (.+)$/m)?.[1] ?? "?";
        return fakeTurn(Promise.resolve(okResult(`reply::${name}`)));
      }
      synthPrompt = req.prompt;
      return fakeTurn(Promise.resolve(okResult("SYNTHESIZED")));
    };

    const outcome = await dispatchFanout({ runAgentTurn, membersRoot: root, members, task });
    expect(outcome.synthesis).toBe("SYNTHESIZED");
    expect(synthPrompt).toBeDefined();
    expect(synthPrompt).toContain(task);
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      expect(synthPrompt).toContain(`reply::${name}`);
    }
  });

  test("#63: a project-bound synthesis turn gets the read rail to verify a cited defect", async () => {
    const repo = await seedProjectRepoWithDiff("synth-rail");
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta")]);
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("ok")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "Adversarial review the diff",
      project: { name: "repo", rootPath: repo },
    });
    expect(outcome.synthesis).toBe("ok");
    // The synthesis turn runs after the member pool, so it is the last request — it must
    // carry the same project-bound read rail the members got, not run blind (#63).
    const synth = reqs[reqs.length - 1];
    expect(synth?.cwd).toBe(repo);
    expect(synth?.allowedDirectories).toEqual([repo]);
    expect((synth?.allowedTools ?? []).length).toBeGreaterThan(0);
  });

  test("synthesis is fail-soft — an errored synthesis turn yields no synthesis + a note", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const task = "T";
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt === task) return fakeTurn(Promise.resolve(okResult("member reply")));
      return fakeTurn(Promise.resolve({ status: "error", text: "", error: "synth blew up" }));
    };

    // Force synthesis on a single-member wave (it now defaults off for one member) so
    // the errored-synthesis fail-soft path is exercised.
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task,
      synthesize: true,
    });
    expect(outcome.synthesis).toBeUndefined();
    expect(outcome.perMember[0]?.status).toBe("ok");
    expect(outcome.notes.some((n) => n.includes("synthesis turn error"))).toBe(true);
  });

  test("caps the wave at maxMembers and records a truncation note", async () => {
    const members = await Promise.all(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s, i) => seed(s, `M${i}`)),
    );
    let calls = 0;
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      calls++;
      return fakeTurn(Promise.resolve(okResult("ok")));
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      maxMembers: 3,
      synthesize: false,
    });
    expect(outcome.perMember).toHaveLength(3);
    expect(calls).toBe(3);
    expect(outcome.notes.some((n) => n.includes("truncated to 3 of 8"))).toBe(true);
  });

  test("a pre-aborted signal yields aborted results without invoking the seam", async () => {
    const members = await Promise.all([seed("a", "Alpha"), seed("b", "Beta")]);
    let calls = 0;
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      calls++;
      return fakeTurn(Promise.resolve(okResult("ok")));
    };
    const ac = new AbortController();
    ac.abort();

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      abortSignal: ac.signal,
    });
    expect(calls).toBe(0);
    expect(outcome.perMember.every((r) => r.status === "aborted")).toBe(true);
    expect(outcome.synthesis).toBeUndefined();
    expect(outcome.notes.length).toBeGreaterThan(0);
  });

  test("reflection is OFF by default — no extra turn, memory untouched", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    let reflectionCalls = 0;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) reflectionCalls++;
      return fakeTurn(Promise.resolve(okResult("substantive reply")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
    });
    expect(reflectionCalls).toBe(0);
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("_(empty)_");
  });

  test("reflect: writes a member's memory.md from its reflection turn on substance", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        // The reflection turn's reply IS the new memory document.
        return fakeTurn(Promise.resolve(okResult("# Memory\n\nThe operator prefers Bun.")));
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("The operator prefers Bun.");
    expect(outcome.notes.some((n) => n.includes("reflection updated a memory"))).toBe(true);
  });

  test("reflect: skips a member with no substance — no reflection turn, memory untouched", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    let reflectionCalls = 0;
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) reflectionCalls++;
      return fakeTurn(Promise.resolve(okResult(""))); // ok but empty -> no substance
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(reflectionCalls).toBe(0);
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("_(empty)_");
    expect(outcome.notes.some((n) => n.includes("no member produced substance"))).toBe(true);
  });

  test("reflect: a failed reflection turn leaves the prior memory intact", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    await writeMemory(root, "a", "PRIOR DURABLE MEMORY");
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        return fakeTurn(
          Promise.resolve({ status: "error", text: "", error: "reflection blew up" }),
        );
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("PRIOR DURABLE MEMORY");
    expect(outcome.notes.some((n) => n.includes("reflection for a error"))).toBe(true);
  });

  test("reflect: an over-cap reflection reply is rejected, prior memory kept", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    await writeMemory(root, "a", "PRIOR DURABLE MEMORY");
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      if (req.prompt.includes("Curate your long-term memory")) {
        return fakeTurn(Promise.resolve(okResult("x".repeat(5000)))); // over MEMORY_DOC_CAP
      }
      return fakeTurn(Promise.resolve(okResult("substantive answer")));
    };
    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      synthesize: false,
      reflect: true,
    });
    expect(await readMemberDoc(root, "a", "memory.md")).toContain("PRIOR DURABLE MEMORY");
    expect(outcome.notes.some((n) => n.includes("not persisted"))).toBe(true);
  });

  test("a turn whose result outlives the timeout is reported as timeout", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const runAgentTurn = (_req: RibAgentTurnRequest): RibAgentTurn => {
      const result = new Promise<RibAgentTurnResult>((resolve) =>
        setTimeout(() => resolve(okResult("late")), 60),
      );
      return fakeTurn(result);
    };

    const outcome = await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "T",
      perTurnTimeoutMs: 20,
      synthesize: false,
    });
    expect(outcome.perMember[0]?.status).toBe("timeout");
  });

  test("a project-bound dispatch grants the member READ tools confined to the repo root", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("read the repo and reviewed it")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review the change",
      synthesize: false,
      project: { name: "demo", rootPath: "/repo/demo" },
    });
    const memberReq = reqs[0];
    expect(memberReq?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(memberReq?.cwd).toBe("/repo/demo");
    expect(memberReq?.allowedDirectories).toEqual(["/repo/demo"]);
    // The framing tells the member it can read — the tools are useless if it doesn't reach for them.
    expect(memberReq?.prompt).toContain("Read, Glob, and Grep");
  });

  test("a dispatch without a project stays text-only (no tools, no cwd)", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("reasoned")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "think about the design",
      synthesize: false,
    });
    expect(reqs[0]?.allowedTools).toBeUndefined();
    expect(reqs[0]?.cwd).toBeUndefined();
    expect(reqs[0]?.prompt).toBe("think about the design");
  });

  test("a project-bound review injects CODE DIFF UNDER REVIEW plus adversarial framing", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = await seedProjectRepoWithDiff("project-review");
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("reviewed")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review this change and find defects",
      synthesize: false,
      project: { name: "demo", rootPath: repo },
    });
    const prompt = reqs[0]?.prompt ?? "";
    expect(prompt).toContain("## CODE DIFF UNDER REVIEW");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("## ADVERSARIAL REVIEW MODE (REFUTE BY DEFAULT)");
    expect(prompt).toContain("RAI VERDICT: BLOCK");
    expect(prompt).toContain("shared mutable object");
  });

  test("a review surfaces brand-new untracked files the tracked diff would hide (#59)", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = await seedProjectRepoWithDiff("project-untracked");
    // A new file git does not track yet — never present in `git diff` (tracked).
    await writeFile(join(repo, "added-module.ts"), "export const ADDED = 'new module body';\n");
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("reviewed")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review this change and find defects",
      synthesize: false,
      project: { name: "demo", rootPath: repo },
    });
    const prompt = reqs[0]?.prompt ?? "";
    expect(prompt).toContain("Untracked (new) files");
    expect(prompt).toContain("added-module.ts");
    // The file's actual content reaches the reviewer as a new-file diff, not just its name.
    expect(prompt).toContain("new module body");
  });

  test("a review diff is capped so a large change cannot blow the reviewer's context (#59)", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = join(root, "project-bigdiff");
    await mkdir(repo, { recursive: true });
    const file = join(repo, "big.ts");
    await writeFile(file, "export const X = 0;\n");
    await execFileAsync("git", ["init"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Dispatch Test"], { cwd: repo });
    await execFileAsync("git", ["add", "big.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    const filler = Array.from(
      { length: 700 },
      (_, i) => `// filler line ${i} ${"=".repeat(40)}`,
    ).join("\n");
    await writeFile(file, `START_MARKER\n${filler}\nZZZ_END_MARKER_ZZZ\n`);
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("reviewed")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review this change",
      synthesize: false,
      project: { name: "demo", rootPath: repo },
    });
    const prompt = reqs[0]?.prompt ?? "";
    expect(prompt).toContain("_[tracked diff truncated");
    // The cut tail (the end of the oversized diff) does not reach the turn.
    expect(prompt).not.toContain("ZZZ_END_MARKER_ZZZ");
    // The cap actually holds: the captured diff (content + truncation note) stays within the
    // 24k budget, not budget + note overhead — the section between the prompt's markers.
    const captured =
      prompt.split("## CODE DIFF UNDER REVIEW\n")[1]?.split("\n\n## ADVERSARIAL")[0] ?? "";
    expect(captured.length).toBeLessThanOrEqual(24_000);
  });

  test("a large tracked diff cannot crowd out new-file visibility (#59)", async () => {
    // Regression for the adversarial-review finding: with a single shared cap that truncates
    // from the front, an oversized tracked diff dropped the whole untracked section (names
    // included). The untracked section now has its own reserved budget, so new files survive.
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = join(root, "project-bigdiff-untracked");
    await mkdir(repo, { recursive: true });
    const file = join(repo, "big.ts");
    await writeFile(file, "export const X = 0;\n");
    await execFileAsync("git", ["init"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Dispatch Test"], { cwd: repo });
    await execFileAsync("git", ["add", "big.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
    const filler = Array.from(
      { length: 700 },
      (_, i) => `// filler line ${i} ${"=".repeat(40)}`,
    ).join("\n");
    await writeFile(file, `${filler}\n`);
    // A brand-new file added alongside the oversized tracked change.
    await writeFile(join(repo, "secret-new.ts"), "export const SECRET = 'new file body';\n");
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("reviewed")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review this change",
      synthesize: false,
      project: { name: "demo", rootPath: repo },
    });
    const prompt = reqs[0]?.prompt ?? "";
    // The tracked diff is capped...
    expect(prompt).toContain("_[tracked diff truncated");
    // ...but the new file's existence and body still reach the reviewer.
    expect(prompt).toContain("Untracked (new) files");
    expect(prompt).toContain("secret-new.ts");
    expect(prompt).toContain("new file body");
  });

  test("isReview forces diff capture regardless of how the instruction reads (#59)", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = await seedProjectRepoWithDiff("project-explicit-review");
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("ok")));
    };
    // A review step phrased WITHOUT any of the sniffed keywords — the heuristic would miss it.
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "is this change correct and safe to ship?",
      synthesize: false,
      project: { name: "demo", rootPath: repo },
      isReview: true,
    });
    expect(reqs[0]?.prompt ?? "").toContain("## CODE DIFF UNDER REVIEW");
  });

  test("isReview:false suppresses capture even when the task reads like a review (#59)", async () => {
    const members = await Promise.all([seed("a", "Alpha")]);
    const repo = await seedProjectRepoWithDiff("project-suppressed-review");
    const reqs: RibAgentTurnRequest[] = [];
    const runAgentTurn = (req: RibAgentTurnRequest): RibAgentTurn => {
      reqs.push(req);
      return fakeTurn(Promise.resolve(okResult("ok")));
    };
    await dispatchFanout({
      runAgentTurn,
      membersRoot: root,
      members,
      task: "review and audit this change", // keyword-laden, but explicitly NOT a review turn
      synthesize: false,
      project: { name: "demo", rootPath: repo },
      isReview: false,
    });
    expect(reqs[0]?.prompt ?? "").not.toContain("## CODE DIFF UNDER REVIEW");
  });
});

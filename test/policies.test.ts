import { describe, expect, test } from "bun:test";
import type { PolicyContext, PolicyEvent, RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { squadPolicies } from "../src/policies.ts";

// The RAI floor is a pure function of (event, ctx), so it tests without a harness:
// build a PolicyEvent + PolicyContext and assert evaluate's decision directly. The
// host (apps/server policy-engine) is what actually evaluates first-deny-wins; here we
// only prove the rib's contributed policy decides correctly.

const RIB: PolicyContext = { surface: "rib" };
const WF: PolicyContext = { surface: "workflow" };
const CHAT: PolicyContext = { surface: "chat" };
const MCP: PolicyContext = { surface: "mcp" };

function floor() {
  const p = squadPolicies().find((x) => x.id === "rai-floor");
  if (!p) throw new Error("rai-floor policy missing");
  return p;
}
async function decide(event: PolicyEvent, ctx: PolicyContext) {
  return floor().evaluate(event, ctx);
}

describe("rai floor contribution", () => {
  test("the rib contributes a rai-floor policy scoped to tool_call + response", () => {
    const policies = rib.contributePolicies?.({} as RibContext) ?? [];
    const p = policies.find((x) => x.id === "rai-floor");
    expect(p).toBeDefined();
    expect(p?.on).toEqual([{ phase: "tool_call" }, { phase: "response" }]);
  });
});

describe("rai floor — merge / force-push", () => {
  test("denies a named merge tool on governed surfaces", async () => {
    for (const ctx of [RIB, WF]) {
      for (const tool of ["gh_pr_merge", "merge_pr", "merge_pull_request", "gh_merge"]) {
        expect((await decide({ phase: "tool_call", tool }, ctx)).outcome).toBe("deny");
      }
    }
  });

  test("denies a `gh pr merge` shell command at per-call time", async () => {
    const d = await decide(
      { phase: "tool_call", tool: "Bash", args: { command: "gh pr merge 42 --squash" } },
      WF,
    );
    expect(d.outcome).toBe("deny");
  });

  test("denies git force-push variants", async () => {
    for (const command of [
      "git push --force",
      "git push -f origin main",
      "git push --force-with-lease",
      "git push origin main --force",
    ]) {
      expect(
        (await decide({ phase: "tool_call", tool: "Bash", args: { command } }, RIB)).outcome,
      ).toBe("deny");
    }
  });

  test("denies force-push / self-merge / delete forms the old flat regex let through", async () => {
    for (const command of [
      "git push -fv origin main", // bundled short flags
      "git -C /repo push --force", // global option before the subcommand
      "git push origin +main", // forced refspec, no flag at all
      "git push origin --delete main", // remote branch deletion
      "git push origin :main",
      "gh api repos/o/r/pulls/1/merge -X PUT", // REST self-merge
    ]) {
      expect(
        (await decide({ phase: "tool_call", tool: "Bash", args: { command } }, RIB)).outcome,
      ).toBe("deny");
    }
  });

  test("allows ordinary pushes, commits, and shell commands", async () => {
    for (const command of [
      "git push origin feature/x",
      "git commit -m 'wip'",
      "git checkout -b fix/thing",
      "bun test",
      "ls -la",
    ]) {
      expect(
        (await decide({ phase: "tool_call", tool: "Bash", args: { command } }, RIB)).outcome,
      ).toBe("allow");
    }
  });

  test("at projection (no args) a shell tool passes; a named merge tool is still denied", async () => {
    expect((await decide({ phase: "tool_call", tool: "Bash" }, RIB)).outcome).toBe("allow");
    expect((await decide({ phase: "tool_call", tool: "merge_pr" }, RIB)).outcome).toBe("deny");
  });
});

describe("rai floor — block verdict", () => {
  test("denies a structured trailing block verdict on the workflow surface", async () => {
    for (const text of [
      '{"verdict":"block","reason":"unsafe"}',
      'Review complete — a concrete defect remains.\n\n{"verdict": "block", "reason": "off-by-one"}',
      '{"verdict":"BLOCK"}',
    ]) {
      expect((await decide({ phase: "response", text }, WF)).outcome).toBe("deny");
    }
  });

  test("allows prose that only quotes or discusses the BLOCK sentinel on the workflow surface", async () => {
    // A workflow investigating the review machinery quotes the sentinel (or a non-trailing
    // verdict example) in passing — not the operative verdict, so the floor must allow it.
    for (const text of [
      "RAI-VERDICT: BLOCK",
      "rai_verdict: block",
      "The bug: hasBlockVerdict matches `RAI VERDICT: BLOCK` anywhere in prose, so an investigation quoting it self-blocks.",
      'A verdict node ends with {"verdict":"block"}, but this response keeps going with more analysis.',
    ]) {
      expect((await decide({ phase: "response", text }, WF)).outcome).toBe("allow");
    }
  });

  test("allows an ordinary review response (no verdict directive)", async () => {
    for (const text of [
      "verdict: pass",
      "Looks good — no blocking issues found.",
      "I would block this if it shipped, but as written it passes.",
    ]) {
      expect((await decide({ phase: "response", text }, WF)).outcome).toBe("allow");
    }
  });

  test("allows any BLOCK verdict on the rib surface — the coordinator owns rib-turn verdicts, not this floor", async () => {
    for (const text of ['{"verdict":"block","reason":"unsafe"}', "RAI-VERDICT: BLOCK"]) {
      expect((await decide({ phase: "response", text }, RIB)).outcome).toBe("allow");
    }
  });
});

describe("rai floor — surface scoping", () => {
  test("does not govern chat or mcp surfaces (the operator's own context)", async () => {
    for (const ctx of [CHAT, MCP]) {
      expect((await decide({ phase: "tool_call", tool: "gh_pr_merge" }, ctx)).outcome).toBe(
        "allow",
      );
      expect(
        (
          await decide(
            { phase: "tool_call", tool: "Bash", args: { command: "git push --force" } },
            ctx,
          )
        ).outcome,
      ).toBe("allow");
      expect((await decide({ phase: "response", text: '{"verdict":"block"}' }, ctx)).outcome).toBe(
        "allow",
      );
    }
  });
});

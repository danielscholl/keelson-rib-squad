import type { Policy, PolicyContext, PolicyDecision, PolicyEvent } from "@keelson/shared";

// Squad's governance floor — the contributePolicies hook chamber skips. Squad agents
// act on real repositories, so the rib contributes a NON-OVERRIDABLE policy the
// harness evaluates first-deny-wins: an agent turn cannot be talked into merging its
// own work or rewriting history, and a review turn that returns a BLOCK verdict fails
// its node rather than being re-prompted past. A prose instruction in a charter is a
// request; this is the enforcement — squad's identity is governed, not merely asked.

// The surfaces squad agents act on: workflow prompt nodes and rib agent turns
// (dispatch / code mode). Chat and MCP are the operator's own context — out of scope,
// per the design: governing the operator's direct session would be overreach.
const GOVERNED_SURFACES = new Set<PolicyContext["surface"]>(["workflow", "rib"]);

// Named merge tools, if a provider exposes git/gh as first-class tools. Matched on the
// tool name, so denied at both projection (dropped from the toolset) and per-call.
// PR *creation* and ordinary pushes are deliberately NOT here — the dev loop ends in a
// draft PR; only the human review gate merges. Force-push is caught below via the shell.
const MERGE_TOOLS = new Set(["merge_pr", "gh_pr_merge", "gh_merge", "merge_pull_request"]);

// Shell tools whose command string we inspect for irreversible git operations.
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "run_command", "execute_command"]);

// The integration-affecting, irreversible git operations the floor forbids from any
// squad agent turn: merging a PR and force-pushing (history rewrite). Branch creation,
// ordinary commits, and ordinary pushes are untouched — only what the human gate owns.
const FORBIDDEN_GIT = /\bgh\s+pr\s+merge\b|\bgit\s+push\b[^\n]*(?:--force|\s-f\b)/i;

// Pull a shell command out of a tool_call's args, whatever the provider names the
// field. Returns "" when nothing string-like is present (e.g. projection time, where
// args is undefined) so the caller falls through to allow.
function shellCommand(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "script", "input"]) {
      const v = o[key];
      if (typeof v === "string") return v;
    }
  }
  return "";
}

// The RAI verdict sentinel a review turn emits to BLOCK integration. The squad-pr-review
// workflow (Phase 2) emits a structured verdict; this matches its block form so a deny
// fails the verdict node, making a BLOCK unappealable by re-prompting the agent.
const BLOCK_VERDICT = /"verdict"\s*:\s*"block"|RAI[-_ ]?VERDICT\s*:\s*BLOCK/i;

const raiFloor: Policy = {
  id: "rai-floor",
  on: [{ phase: "tool_call" }, { phase: "response" }],
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision {
    if (!GOVERNED_SURFACES.has(ctx.surface)) return { outcome: "allow" };

    if (event.phase === "tool_call") {
      if (MERGE_TOOLS.has(event.tool)) {
        return {
          outcome: "deny",
          reason: `squad RAI floor: '${event.tool}' (merge/PR-write) is reserved for the human review gate`,
        };
      }
      if (SHELL_TOOLS.has(event.tool)) {
        const cmd = shellCommand(event.args);
        if (cmd && FORBIDDEN_GIT.test(cmd)) {
          return {
            outcome: "deny",
            reason:
              "squad RAI floor: merging or force-pushing is reserved for the human review gate",
          };
        }
      }
      return { outcome: "allow" };
    }

    // response phase: a BLOCK verdict fails the node (the engine clears the text).
    if (event.phase === "response" && BLOCK_VERDICT.test(event.text)) {
      return {
        outcome: "deny",
        reason: "squad RAI floor: review returned a BLOCK verdict — integration is blocked",
      };
    }
    return { outcome: "allow" };
  },
};

// The rib's contributePolicies return. A factory (not a bare const) so a future
// policy can be added without reshaping the call site, and so each boot gets a fresh
// array the harness can namespace (rib:squad:rai-floor).
export function squadPolicies(): readonly Policy[] {
  return [raiFloor];
}

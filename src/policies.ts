import type { Policy, PolicyContext, PolicyDecision, PolicyEvent } from "@keelson/shared";
import { extractTrailingJsonObject } from "./control-json.ts";
import { isForbiddenGitCommand, isMergeToolName } from "./forbidden.ts";

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

// Shell tools whose command string we inspect for irreversible git operations. The
// detection itself (force-push variants, +refspec, branch deletion, `gh pr merge`,
// `gh api … /merge`) lives in forbidden.ts so the screen and this floor share one
// tokenizing matcher. PR *creation* and ordinary pushes are deliberately allowed — the
// dev loop ends in a draft PR; only the human review gate merges.
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "run_command", "execute_command"]);

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

// The prose verdict sentinel the coordinator's own done-gate reads in a reviewer's
// synthesis (RAI VERDICT: BLOCK), on the rib surface. Kept loose on purpose — the
// reviewer writes it as prose — and consumed by the coordinator, not this floor.
const BLOCK_VERDICT = /"verdict"\s*:\s*"block"|RAI[-_ ]?VERDICT\s*:\s*BLOCK/i;

export function hasBlockVerdict(text: string): boolean {
  return BLOCK_VERDICT.test(text);
}

// A STRUCTURED block verdict: a well-formed, genuinely-trailing {"verdict":"block"} —
// the shape a review workflow's verdict node emits. The workflow-surface deny wants
// this, not the loose prose sentinel above: matching that on every workflow response
// self-blocks any turn that merely quotes it (an investigation of the review machinery).
export function hasBlockVerdictDirective(text: string): boolean {
  const json = extractTrailingJsonObject(text);
  if (!json) return false;
  const idx = text.lastIndexOf(json);
  if (text.slice(idx + json.length).trim().length > 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const verdict = (parsed as Record<string, unknown>).verdict;
  return typeof verdict === "string" && verdict.trim().toLowerCase() === "block";
}

// Squad's own workflows all carry the `squad-` name prefix. The host stamps the
// running workflow's name onto PolicyContext.workflowName on the workflow surface,
// so the block-verdict floor enforces only squad's own review workflows — a foreign
// workflow whose output merely ends with the verdict directive is left to its own
// governance. An older host that doesn't populate workflowName reports undefined,
// so the floor stands down there rather than gating a workflow it can't identify.
function isOwnWorkflow(workflowName: string | undefined): boolean {
  return typeof workflowName === "string" && workflowName.startsWith("squad-");
}

const raiFloor: Policy = {
  id: "rai-floor",
  on: [{ phase: "tool_call" }, { phase: "response" }],
  evaluate(event: PolicyEvent, ctx: PolicyContext): PolicyDecision {
    if (!GOVERNED_SURFACES.has(ctx.surface)) return { outcome: "allow" };

    if (event.phase === "tool_call") {
      if (isMergeToolName(event.tool)) {
        return {
          outcome: "deny",
          reason: `squad RAI floor: '${event.tool}' (merge/PR-write) is reserved for the human review gate`,
        };
      }
      if (SHELL_TOOLS.has(event.tool)) {
        const cmd = shellCommand(event.args);
        if (cmd && isForbiddenGitCommand(cmd)) {
          return {
            outcome: "deny",
            reason:
              "squad RAI floor: merging or force-pushing is reserved for the human review gate",
          };
        }
      }
      return { outcome: "allow" };
    }

    // response phase: deny only a STRUCTURED block verdict emitted by one of squad's
    // OWN workflows — the trailing {"verdict":"block"} a review node produces. Scoping
    // to the workflow name keeps the floor off a foreign workflow whose output merely
    // ends with the directive; the trailing-structure check (not the loose prose
    // sentinel) additionally spares a squad turn that only quotes it.
    if (
      event.phase === "response" &&
      ctx.surface === "workflow" &&
      isOwnWorkflow(ctx.workflowName) &&
      hasBlockVerdictDirective(event.text)
    ) {
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

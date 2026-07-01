import { afterAll, describe, expect, it } from "bun:test";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { CAST_KEY, DECISIONS_KEY, ROSTER_KEY, SQUAD_SURFACE_ID } from "../src/keys.ts";
import { setSquadDataHome } from "../src/paths.ts";

// The shapes the host parses out of contributeWorkflows — typed loosely here since
// the rib never imports the @keelson/workflows schema (it only peer-deps shared).
type RawNode = {
  id?: string;
  bash?: string;
  prompt?: string;
  output_schema?: unknown;
  memory?: {
    recall?: { query?: string; limits?: { maxItems?: number } };
    writeback?: { on?: string; type?: string; summary?: string; content?: string };
  };
};
function wf(name: string) {
  const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
  return wfs.find((w) => (w.definition as { name?: string }).name === name);
}
function nodes(name: string): RawNode[] {
  return ((wf(name)?.definition as { nodes?: RawNode[] }).nodes ?? []) as RawNode[];
}

// registerTools (exercised below) captures the data home into a module global;
// clear it after this file so the bootstrap doesn't leak a home into the next.
afterAll(() => setSquadDataHome(undefined));

// A ctx with no seams — enough to drive registerTools/onAction without a harness.
const bareCtx = {
  getExec: () => ({
    runJSON: async () => ({ ok: true as const, data: undefined }),
    runText: async () => ({ ok: true as const, data: "" }),
  }),
} as unknown as RibContext;

describe("rib-squad", () => {
  it("exposes a squad rib identity", () => {
    expect(rib.id).toBe("squad");
    expect(rib.displayName).toBe("Squad");
  });

  it("declares the roster view bound to the canvas renderer", () => {
    const view = rib.views?.find((v) => v.key === ROSTER_KEY);
    expect(view?.canvasKind).toBe("view");
  });

  it("declares the Squad surface with the roster in the header", () => {
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe(SQUAD_SURFACE_ID);
    expect(surface?.layout.header?.key).toBe(ROSTER_KEY);
    expect(surface?.layout.header?.workflow).toBe("squad-roster");
    expect(surface?.layout.header?.cadenceMs).toBeGreaterThanOrEqual(30_000);
  });

  it("declares no static actions — every control is a workflow or a board action", () => {
    expect(Object.hasOwn(rib, "actions")).toBe(false);
  });

  it("contributes squad-roster (bound, deterministic collector) and squad-genesis", () => {
    const wfs = rib.contributeWorkflows?.({} as RibContext) ?? [];
    const roster = wfs.find((w) => (w.definition as { name?: string }).name === "squad-roster");
    expect(roster?.bindSnapshotKey).toBe(ROSTER_KEY);
    const node = (roster?.definition as { nodes?: { bash?: string; output_schema?: unknown }[] })
      .nodes?.[0];
    expect(node?.bash).toContain("collect-roster.ts");
    expect(node?.output_schema).toBeDefined();

    const genesis = wfs.find((w) => (w.definition as { name?: string }).name === "squad-genesis");
    expect(genesis?.bindSnapshotKey).toBeUndefined();
    const gNode = (
      genesis?.definition as {
        nodes?: { allowed_tools?: string[]; fail_on_tool_error?: boolean }[];
      }
    ).nodes?.[0];
    expect(gNode?.allowed_tools).toEqual(["squad_emit_member"]);
    expect(gNode?.fail_on_tool_error).toBe(true);
  });

  it("registers the write/read/remember/dispatch/code/runs/coordinate tools without any seams", () => {
    expect((rib.registerTools?.(bareCtx) ?? []).map((t) => t.name).sort()).toEqual([
      "squad_code",
      "squad_coordinate",
      "squad_dispatch",
      "squad_emit_member",
      "squad_list_members",
      "squad_remember",
      "squad_retire_member",
      "squad_runs",
    ]);
  });

  it("contributes the RAI policy floor via contributePolicies", () => {
    const policies = rib.contributePolicies?.(bareCtx) ?? [];
    expect(policies.map((p) => p.id)).toContain("rai-floor");
  });

  it("squad_code fails closed when the agent-turn seam is absent", async () => {
    const code = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_code");
    expect(code?.state_changing).toBe(true);
    const chunks: { content?: string; isError?: boolean }[] = [];
    await code?.execute({ member: "atlas", task: "do the thing" }, {
      emit: (c: { content?: string; isError?: boolean }) => chunks.push(c),
    } as never);
    expect(chunks[0]?.isError).toBe(true);
    expect(chunks[0]?.content).toContain("seam");
  });

  it("squad_dispatch fails closed when the agent-turn seam is absent", async () => {
    const dispatch = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_dispatch");
    expect(dispatch?.state_changing).toBe(true);
    const chunks: { content?: string; isError?: boolean }[] = [];
    await dispatch?.execute({ task: "do the thing" }, {
      emit: (c: { content?: string; isError?: boolean }) => chunks.push(c),
    } as never);
    expect(chunks[0]?.isError).toBe(true);
    expect(chunks[0]?.content).toContain("agent-turn seam unavailable");
  });

  it("squad_coordinate schema accepts valid maxStall and maxResets", () => {
    const coord = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_coordinate");
    const schema = (coord as { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } })
      ?.inputSchema;
    expect(schema?.safeParse({ task: "do", maxRounds: 5, maxStall: 2, maxResets: 1 }).success).toBe(
      true,
    );
    expect(schema?.safeParse({ task: "do" }).success).toBe(true);
  });

  it("squad_coordinate schema accepts optional manager provider/model pins", () => {
    const coord = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_coordinate");
    const schema = (coord as { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } })
      ?.inputSchema;
    expect(
      schema?.safeParse({
        task: "do",
        managerProvider: "copilot",
        managerModel: "gpt-5.5",
      }).success,
    ).toBe(true);
  });

  it("squad_coordinate schema rejects out-of-range maxStall and maxResets", () => {
    const coord = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_coordinate");
    const schema = (coord as { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } })
      ?.inputSchema;
    expect(schema?.safeParse({ task: "do", maxStall: 0 }).success).toBe(false);
    expect(schema?.safeParse({ task: "do", maxStall: 21 }).success).toBe(false);
    expect(schema?.safeParse({ task: "do", maxResets: 0 }).success).toBe(false);
    expect(schema?.safeParse({ task: "do", maxResets: 21 }).success).toBe(false);
  });

  it("squad_coordinate fails closed when the agent-turn seam is absent (partial limits)", async () => {
    const coord = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_coordinate");
    const chunks: { content?: string; isError?: boolean }[] = [];
    // Only maxStall provided — exercises the partial-set path without needing a real harness.
    await coord?.execute({ task: "do the thing", maxStall: 3 }, {
      emit: (c: { content?: string; isError?: boolean }) => chunks.push(c),
    } as never);
    expect(chunks[0]?.isError).toBe(true);
    expect(chunks[0]?.content).toContain("agent-turn seam unavailable");
  });

  it("squad_coordinate schema bounds maxRounds to 1..100 (the default 24 is a valid input)", () => {
    const coord = (rib.registerTools?.(bareCtx) ?? []).find((t) => t.name === "squad_coordinate");
    const schema = (coord as { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } })
      ?.inputSchema;
    expect(schema?.safeParse({ task: "do", maxRounds: 0 }).success).toBe(false);
    expect(schema?.safeParse({ task: "do", maxRounds: 101 }).success).toBe(false);
    expect(schema?.safeParse({ task: "do", maxRounds: 24 }).success).toBe(true);
  });

  it("rejects any action relayed from an HTML canvas (no chart iframe in Phase 0)", async () => {
    const res = await rib.onAction?.(
      { type: "enter-member", payload: { slug: "lead" }, origin: "canvas-html" },
      bareCtx,
    );
    expect(res).toEqual({
      ok: false,
      error: "'enter-member' is not permitted from an HTML canvas",
    });
  });

  it("an unknown trusted action fails closed", async () => {
    const res = await rib.onAction?.({ type: "bogus" }, bareCtx);
    expect(res).toEqual({ ok: false, error: "unknown action 'bogus'" });
  });

  it("author-archetype resolves to a run-workflow effect carrying the starter brief", async () => {
    const res = await rib.onAction?.(
      { type: "author-archetype", payload: { slug: "lead" } },
      bareCtx,
    );
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      const data = res.data as { effect: string; workflow: string; args: { brief: string } };
      expect(data.effect).toBe("run-workflow");
      expect(data.workflow).toBe("squad-genesis");
      expect(data.args.brief.length).toBeGreaterThan(0);
    }
  });

  it("declares the decisions view and a cadence-less Decisions surface region", () => {
    const view = rib.views?.find((v) => v.key === DECISIONS_KEY);
    expect(view?.canvasKind).toBe("view");
    const region = rib.surfaces?.[0]?.layout.rows?.[0]?.columns.find(
      (c) => c.key === DECISIONS_KEY,
    );
    expect(region?.workflow).toBe("squad-decisions");
    // Cost-safety: an agent-turn board must NOT carry a cadence (it would burn
    // paid turns on the heartbeat).
    expect(region?.cadenceMs).toBeUndefined();
  });

  it("contributes squad-decide carrying a project-scope decision writeback block", () => {
    const node = nodes("squad-decide")[0];
    // A cheap bash node (no paid turn) carries the declarative writeback — the only
    // supported path for a rib to reach the governed ledger.
    expect(typeof node?.bash).toBe("string");
    expect(wf("squad-decide")?.bindSnapshotKey).toBeUndefined();
    expect(node?.memory?.writeback?.type).toBe("decision");
    expect(node?.memory?.writeback?.on).toBe("success");
    expect(node?.memory?.writeback?.summary).toBe("$inputs.summary");
    expect(node?.memory?.writeback?.content).toBe("$inputs.content");
  });

  it("contributes squad-decisions: a bound recall->board render workflow", () => {
    const contribution = wf("squad-decisions");
    expect(contribution?.bindSnapshotKey).toBe(DECISIONS_KEY);
    const node = nodes("squad-decisions")[0];
    expect(node?.memory?.recall?.query).toBeTruthy();
    expect(node?.memory?.recall?.limits?.maxItems).toBe(50);
    expect(typeof node?.prompt).toBe("string");
    // The prompt embeds the buildDecisionsBoard contract so the model emits a board
    // matching the tested builder, and includes the record action.
    expect(node?.prompt).toContain('"view":"board"');
    expect(node?.prompt).toContain("record-decision");
    expect(node?.output_schema).toBeDefined();
  });

  it("validate on squad-decisions rejects a non-board frame (fail closed)", () => {
    const validate = wf("squad-decisions")?.validate;
    expect(validate).toBeDefined();
    expect(() => validate?.({ view: "table", columns: [], rows: [] })).toThrow();
    expect(validate?.({ view: "board", sections: [] })).toEqual({ view: "board", sections: [] });
  });

  it("record-decision requires both fields and otherwise launches squad-decide", async () => {
    const noSummary = await rib.onAction?.(
      { type: "record-decision", payload: { content: "details" } },
      bareCtx,
    );
    expect(noSummary?.ok).toBe(false);
    const noContent = await rib.onAction?.(
      { type: "record-decision", payload: { summary: "we decided X" } },
      bareCtx,
    );
    expect(noContent?.ok).toBe(false);
    const ok = await rib.onAction?.(
      { type: "record-decision", payload: { summary: "we decided X", content: "because Y" } },
      bareCtx,
    );
    expect(ok?.ok).toBe(true);
    if (ok?.ok) {
      const data = ok.data as { effect: string; workflow: string; args: Record<string, string> };
      expect(data.effect).toBe("run-workflow");
      expect(data.workflow).toBe("squad-decide");
      expect(data.args).toEqual({ summary: "we decided X", content: "because Y" });
    }
  });

  it("declares the cast view and a cadence-less Proposed-squad surface region", () => {
    const view = rib.views?.find((v) => v.key === CAST_KEY);
    expect(view?.canvasKind).toBe("view");
    const region = rib.surfaces?.[0]?.layout.rows
      ?.flatMap((r) => r.columns)
      .find((c) => c.key === CAST_KEY);
    expect(region?.workflow).toBe("squad-cast");
    // The cast collector is cheap, but the panel only changes on propose/approve/
    // discard — no heartbeat (it would just re-render the idle board).
    expect(region?.cadenceMs).toBeUndefined();
    expect(region?.collapsed).toBe(true);
  });

  it("contributes squad-cast: a bound deterministic cast collector", () => {
    const contribution = wf("squad-cast");
    expect(contribution?.bindSnapshotKey).toBe(CAST_KEY);
    const node = nodes("squad-cast")[0];
    expect(node?.bash).toContain("collect-cast.ts");
    expect(node?.output_schema).toBeDefined();
    // Fail-closed validator: a non-board frame is rejected at the binding edge.
    const validate = contribution?.validate;
    expect(() => validate?.({ view: "table", columns: [], rows: [] })).toThrow();
  });

  it("cast-propose fails closed without the agent-turn / projects seams", async () => {
    rib.registerTools?.(bareCtx);
    const res = await rib.onAction?.({ type: "cast-propose", payload: {} }, bareCtx);
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res?.error).toContain("seam");
  });

  it("describe-own requires a brief and otherwise resolves to a run-workflow effect", async () => {
    const empty = await rib.onAction?.({ type: "describe-own", payload: {} }, bareCtx);
    expect(empty?.ok).toBe(false);
    const ok = await rib.onAction?.(
      { type: "describe-own", payload: { brief: "a terse SRE" } },
      bareCtx,
    );
    expect(ok?.ok).toBe(true);
    if (ok?.ok) {
      const data = ok.data as { workflow: string; args: { brief: string } };
      expect(data.workflow).toBe("squad-genesis");
      expect(data.args.brief).toBe("a terse SRE");
    }
  });
});

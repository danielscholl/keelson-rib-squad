import { afterAll, describe, expect, it } from "bun:test";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { ROSTER_KEY, SQUAD_SURFACE_ID } from "../src/keys.ts";
import { setSquadDataHome } from "../src/paths.ts";

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

  it("registers the always-on write/read/cleanup tools without any seams", () => {
    expect((rib.registerTools?.(bareCtx) ?? []).map((t) => t.name).sort()).toEqual([
      "squad_emit_member",
      "squad_list_members",
      "squad_retire_member",
    ]);
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

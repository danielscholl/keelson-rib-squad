import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildRunDetailBoard,
  REPORT_RUN_ACTION,
  ROLLBACK_RUN_ACTION,
} from "../../src/boards/coordinator.ts";
import { buildRunsBoard, VIEW_RUN_ACTION } from "../../src/boards/runs.ts";
import type { CoordinatorLedger } from "../../src/coordinator.ts";
import type { RunSummary } from "../../src/runs-store.ts";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "2026-07-02T16-14-45-216Z",
  task: "Implement **the** usage tab",
  status: "done",
  round: 11,
  createdAt: "2026-07-02T16:14:45.216Z",
  updatedAt: "2026-07-02T16:54:00.000Z",
  ...over,
});

describe("buildRunsBoard", () => {
  test("renders one card per run with a status pill and a View action carrying the id", () => {
    const board = buildRunsBoard([run(), run({ id: "r2", status: "max-rounds", round: 16 })]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    expect(cards.items).toHaveLength(2);
    const first = cards.items[0];
    // Markdown is stripped from the task title.
    expect(first?.title).toBe("Implement the usage tab");
    expect(first?.pill?.label).toBe("done");
    expect(first?.pill?.tone).toBe("ok");
    const view = first?.actions?.[0];
    expect(view?.type).toBe(VIEW_RUN_ACTION);
    expect(view?.payload).toEqual({ id: "2026-07-02T16-14-45-216Z" });
    const report = first?.actions?.find((a) => a.type === REPORT_RUN_ACTION);
    expect(report?.payload).toEqual({ runId: "2026-07-02T16-14-45-216Z" });
    expect(cards.items[1]?.pill?.tone).toBe("caution");
  });

  test("active cards carry a Stop action targeting the caller's scope", () => {
    const board = buildRunsBoard([run({ status: "active", scopeId: "stale" })], "beta");
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    const stop = cards.items[0]?.actions?.find((a) => a.type === "stop-coordinate");
    expect(stop?.payload).toEqual({ scopeId: "beta" });
    expect(stop?.destructive).toBe(true);
    const done = buildRunsBoard([run()], "beta");
    const doneCards = done.sections.find((s) => s.kind === "cards");
    if (doneCards?.kind !== "cards") throw new Error("no cards section");
    expect(doneCards.items[0]?.actions?.some((a) => a.type === "stop-coordinate")).toBe(false);
  });

  test("rollback appears only on aborted and failed cards with preview payload", () => {
    const board = buildRunsBoard(
      [
        run({ id: "done", task: "done", status: "done" }),
        run({ id: "live", task: "live", status: "active" }),
        run({ id: "aborted", task: "aborted", status: "aborted", scopeId: "stale" }),
        run({ id: "verify", task: "verify", status: "verification-failed" }),
        run({ id: "quality", task: "quality", status: "change-quality-failed" }),
        run({ id: "rounds", task: "rounds", status: "max-rounds" }),
      ],
      "beta",
    );
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    const byTitle = new Map(cards.items.map((item) => [item.title, item]));

    expect(byTitle.get("done")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
    expect(byTitle.get("live")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
    expect(byTitle.get("rounds")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);

    for (const id of ["aborted", "verify", "quality"]) {
      const rollback = byTitle.get(id)?.actions?.find((a) => a.type === ROLLBACK_RUN_ACTION);
      expect(rollback?.destructive).toBe(true);
      expect(rollback?.payload).toEqual({ run: id, confirm: false, scopeId: "beta" });
      expect(rollback?.confirm?.confirmLabel).toBe("Preview rollback");
      expect(rollback?.confirm?.body).toContain("C/M/D manifest");
    }
  });

  test("no runs renders an empty-content idle board", () => {
    const board = buildRunsBoard([]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("no runs");
    expect(board.sections).toEqual([]);
  });
});

describe("buildRunDetailBoard", () => {
  const ledger = (over: Partial<CoordinatorLedger> = {}): CoordinatorLedger => ({
    task: "ship it",
    facts: [],
    plan: [],
    round: 3,
    stallCount: 0,
    resetCount: 0,
    status: "done",
    summary: "shipped",
    transcript: [
      { round: 0, kind: "code", speaker: "atlas", text: "edited", provider: "claude" },
      { round: 1, kind: "verify", text: "verification passed: 2 checks", verdict: "pass" },
    ],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:30:00.000Z",
    ...over,
  });

  test("renders the archived run's sections without the task composer", () => {
    const board = buildRunDetailBoard(ledger(), "r1");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.title).toBe("Run");
    expect(board.header?.chip).toBe("r1");
    expect(board.header?.status?.label).toBe("done");
    // A history drawer is read-only: no composer; the only verb is the run-report opener.
    const actions = board.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    const report = actions[0]?.kind === "actions" ? actions[0].items[0] : undefined;
    expect(report?.type).toBe(REPORT_RUN_ACTION);
    expect(report?.payload).toEqual({ runId: "r1" });
    // The full run body is there: standup + gate history + minds + ledger groups.
    const titles = board.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles).toContain("Standup");
    expect(titles).toContain("Gate history");
    expect(titles).toContain("Minds");
  });

  test("renders a two-series tokens chart aggregated by numeric round", () => {
    const board = buildRunDetailBoard(
      ledger({
        transcript: [
          {
            round: 1,
            kind: "code",
            speaker: "atlas",
            text: "edited",
            usage: { inputTokens: 100, outputTokens: 20 },
          },
          { round: 1, kind: "dispatch", speaker: "nova", text: "read" },
          {
            round: 2,
            kind: "workflow",
            speaker: "atlas",
            text: "checked",
            usage: { inputTokens: 50, outputTokens: 10 },
          },
          {
            round: 2,
            kind: "code",
            speaker: "nova",
            text: "fixed",
            usage: { inputTokens: 25, outputTokens: 5 },
          },
        ],
      }),
      "r1",
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const charts = board.sections.filter((s) => s.kind === "chart");
    expect(charts).toHaveLength(1);
    const chart = charts[0];
    if (chart?.kind !== "chart") throw new Error("no chart section");
    expect(chart.title).toBe("Tokens per round");
    expect(chart.yLabel).toBe("tokens");
    expect(chart.series).toEqual([
      {
        label: "input",
        points: [
          { x: 1, y: 100 },
          { x: 2, y: 75 },
        ],
      },
      {
        label: "output",
        points: [
          { x: 1, y: 20 },
          { x: 2, y: 15 },
        ],
      },
    ]);
    expect(typeof chart.series[0]?.points[0]?.x).toBe("number");
  });

  test("omits the tokens chart when fewer than two rounds carry usage", () => {
    const board = buildRunDetailBoard(
      ledger({
        transcript: [
          {
            round: 1,
            kind: "code",
            speaker: "atlas",
            text: "edited",
            usage: { inputTokens: 100, outputTokens: 20 },
          },
          { round: 2, kind: "dispatch", speaker: "nova", text: "read" },
        ],
      }),
      "r1",
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections.some((s) => s.kind === "chart")).toBe(false);
  });

  test("counts missing round usage as zero without NaN points", () => {
    const board = buildRunDetailBoard(
      ledger({
        transcript: [
          {
            round: 1,
            kind: "code",
            speaker: "atlas",
            text: "edited",
            usage: { inputTokens: 100, outputTokens: 20 },
          },
          { round: 2, kind: "dispatch", speaker: "nova", text: "read" },
          {
            round: 3,
            kind: "workflow",
            speaker: "atlas",
            text: "checked",
            usage: { inputTokens: 50, outputTokens: 10 },
          },
        ],
      }),
      "r1",
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const chart = board.sections.find((s) => s.kind === "chart");
    if (chart?.kind !== "chart") throw new Error("no chart section");
    expect(chart.series[0]?.points).toEqual([
      { x: 1, y: 100 },
      { x: 2, y: 0 },
      { x: 3, y: 50 },
    ]);
    expect(chart.series[1]?.points).toEqual([
      { x: 1, y: 20 },
      { x: 2, y: 0 },
      { x: 3, y: 10 },
    ]);
    for (const series of chart.series) {
      for (const point of series.points) {
        expect(Number.isNaN(point.y)).toBe(false);
      }
    }
  });

  test("shows every round of the ledger — the archive drill-down never stubs", () => {
    const transcript = Array.from({ length: 8 }, (_, r) => ({
      round: r,
      kind: "coordinator" as const,
      text: `round ${r} thinking`,
    }));
    const board = buildRunDetailBoard(ledger({ round: 8, transcript }), "r1");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = board.sections
      .filter((s) => s.kind === "rows")
      .flatMap((s) => (s.kind === "rows" ? s.items : []));
    expect(rows.some((r) => r.text.includes("earlier"))).toBe(false);
    for (let r = 0; r < 8; r++) {
      expect(rows.some((row) => row.text.includes(`round ${r} thinking`))).toBe(true);
    }
  });

  test("an unknown run renders a calm not-found board", () => {
    const board = buildRunDetailBoard(undefined, "missing-id");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("not found");
    expect(JSON.stringify(board)).toContain("missing-id");
  });
});

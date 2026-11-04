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
    // (no dot: the pill alone carries the status)
    const board = buildRunsBoard([
      run(),
      run({ id: "r2", status: "max-rounds", round: 16 }),
      run({ id: "r3", status: "max-tokens", round: 4 }),
    ]);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    expect(cards.items).toHaveLength(3);
    const first = cards.items[0];
    // Markdown is stripped from the task title.
    expect(first?.title).toBe("Implement the usage tab");
    expect(first?.pill?.label).toBe("done");
    expect(first?.pill?.tone).toBe("ok");
    expect(first?.dot).toBeUndefined();
    expect(first?.fields).toEqual([
      { label: "rounds", value: 11 },
      { label: "ended", value: "Jul 2, 16:54" },
    ]);
    const view = first?.actions?.[0];
    expect(view?.type).toBe(VIEW_RUN_ACTION);
    expect(view?.payload).toEqual({ id: "2026-07-02T16-14-45-216Z" });
    const report = first?.actions?.find((a) => a.type === REPORT_RUN_ACTION);
    expect(report?.payload).toEqual({ runId: "2026-07-02T16-14-45-216Z" });
    expect(cards.items[1]?.pill).toEqual({ label: "max rounds", tone: "caution" });
    expect(cards.items[2]?.pill).toEqual({ label: "max tokens", tone: "caution" });
  });

  test("active cards carry a Stop action targeting the caller's scope", () => {
    const board = buildRunsBoard([run({ status: "active", scopeId: "stale" })], "beta");
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    expect(cards.items[0]?.fields?.find((f) => f.label === "updated")?.value).toBe("Jul 2, 16:54");
    const stop = cards.items[0]?.actions?.find((a) => a.type === "stop-coordinate");
    expect(stop?.payload).toEqual({ scopeId: "beta" });
    expect(stop?.destructive).toBe(true);
    const done = buildRunsBoard([run()], "beta");
    const doneCards = done.sections.find((s) => s.kind === "cards");
    if (doneCards?.kind !== "cards") throw new Error("no cards section");
    expect(doneCards.items[0]?.actions?.some((a) => a.type === "stop-coordinate")).toBe(false);
  });

  test("rollback appears only on aborted and failed cards, inline, with preview payload", () => {
    const board = buildRunsBoard(
      [
        run({ id: "done", task: "done", status: "done" }),
        run({ id: "live", task: "live", status: "active" }),
        run({ id: "aborted", task: "aborted", status: "aborted", scopeId: "stale" }),
        run({ id: "verify", task: "verify", status: "verification-failed" }),
        run({ id: "quality", task: "quality", status: "change-quality-failed" }),
        run({ id: "rounds", task: "rounds", status: "max-rounds" }),
        run({ id: "tokens", task: "tokens", status: "max-tokens" }),
      ],
      "beta",
    );
    const cards = board.sections.find((s) => s.kind === "cards");
    if (cards?.kind !== "cards") throw new Error("no cards section");
    const byTitle = new Map(cards.items.map((item) => [item.title, item]));

    expect(byTitle.get("done")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
    expect(byTitle.get("live")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
    expect(byTitle.get("rounds")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
    expect(byTitle.get("tokens")?.actions?.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);

    for (const id of ["aborted", "verify", "quality"]) {
      const rollback = byTitle.get(id)?.actions?.find((a) => a.type === ROLLBACK_RUN_ACTION);
      // The card's Rollback only opens a preview, so it isn't styled as the destructive step.
      expect(rollback?.destructive).toBeUndefined();
      expect(rollback?.inline).toBe(true);
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
    // The drawer is titled by its task; the chip says how long the run took.
    expect(board.title).toBe("ship it");
    expect(board.header?.chip).toBe("30 min");
    expect(board.header?.status?.label).toBe("done");
    // Stats lead, then the report opener; exactly one stats strip.
    expect(board.sections[0]?.kind).toBe("stats");
    expect(board.sections.filter((s) => s.kind === "stats")).toHaveLength(1);
    // A history drawer is read-only: no composer; the only verb is the run-report opener.
    const actions = board.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    expect(board.sections[1]).toBe(actions[0]);
    expect(actions[0]?.kind === "actions" ? actions[0].wrap : undefined).toBe(true);
    const report = actions[0]?.kind === "actions" ? actions[0].items[0] : undefined;
    expect(report?.type).toBe(REPORT_RUN_ACTION);
    expect(report?.label).toBe("Open report");
    expect(report?.payload).toEqual({ runId: "r1" });
    // The full run body is there: standup + minds + ledger groups. One green gate needs
    // no Gate history of its own.
    const titles = board.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles).toContain("Standup");
    expect(titles).not.toContain("Gate history");
    expect(titles).toContain("Minds");
    // The task fits the title, so a Goal row would only repeat it.
    expect(titles).not.toContain("Goal");
  });

  test("keeps the Goal row when the title had to cut a long task short", () => {
    const task = `ship the search rib ${"and more ".repeat(20)}`.trim();
    const board = buildRunDetailBoard(ledger({ task }), "r1");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.title?.endsWith("…")).toBe(true);
    const titles = board.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles).toContain("Goal");
  });

  test("a settled run reports its round count and drops counters that stayed at zero", () => {
    const board = buildRunDetailBoard(ledger({ roundBudget: 12 }), "r1");
    const stats = board.sections[0];
    if (stats?.kind !== "stats") throw new Error("no stats");
    expect(stats.items.map((i) => i.label)).toEqual(["Rounds", "Findings"]);
    expect(stats.items[0]?.value).toBe(3);
    const replanned = buildRunDetailBoard(ledger({ resetCount: 2 }), "r1").sections[0];
    if (replanned?.kind !== "stats") throw new Error("no stats");
    expect(replanned.items.map((i) => i.label)).toContain("Re-plans");
  });

  test("closes with the tokens chart, after the Ledger", () => {
    const board = buildRunDetailBoard(
      ledger({
        transcript: [
          {
            round: 1,
            kind: "code",
            speaker: "atlas",
            text: "a",
            usage: { inputTokens: 9, outputTokens: 1 },
          },
          {
            round: 2,
            kind: "code",
            speaker: "atlas",
            text: "b",
            usage: { inputTokens: 9, outputTokens: 1 },
          },
          { round: 3, kind: "verify", text: "verification passed", verdict: "pass" },
        ],
      }),
      "r1",
    );
    const kinds = board.sections.map((s) => ("title" in s && s.title ? s.title : s.kind));
    expect(kinds.at(-1)).toBe("Tokens per round");
    expect(kinds.indexOf("Minds")).toBeLessThan(kinds.length - 1);
  });

  test("falls back to the raw id when createdAt isn't a timestamp", () => {
    const board = buildRunDetailBoard(ledger({ createdAt: "garbage" }), "r1");
    expect(board.header?.chip).toBe("r1");
  });

  test("renders one tokens series per round, labelled R1, R2…", () => {
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
    expect(chart.mark).toBe("bar");
    expect(chart.yLabel).toBeUndefined();
    expect(chart.series).toEqual([
      {
        label: "tokens",
        points: [
          { x: "R1", y: 120 },
          { x: "R2", y: 90 },
        ],
      },
    ]);
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

  test("plots every round, a round that spent no tokens at zero", () => {
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
    expect(chart.series).toHaveLength(1);
    expect(chart.series[0]?.points).toEqual([
      { x: "R1", y: 120 },
      { x: "R2", y: 0 },
      { x: "R3", y: 60 },
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

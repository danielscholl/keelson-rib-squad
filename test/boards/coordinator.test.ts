import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildCoordinatorBoard,
  identityTone,
  outcomeTone,
  transcriptTrailing,
} from "../../src/boards/coordinator.ts";
import type { CoordinatorEntry, CoordinatorLedger } from "../../src/coordinator.ts";

const ledger = (over: Partial<CoordinatorLedger> = {}): CoordinatorLedger => ({
  task: "ship the search rib",
  facts: [],
  plan: [],
  round: 0,
  stallCount: 0,
  resetCount: 0,
  status: "active",
  transcript: [],
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
  ...over,
});

const entry = (over: Partial<CoordinatorEntry> = {}): CoordinatorEntry => ({
  round: 0,
  kind: "coordinator",
  text: "thinking",
  ...over,
});

type Board = ReturnType<typeof buildCoordinatorBoard>;
type RowItem = {
  icon?: string;
  glyph?: string;
  chip?: { label: string };
  text: string;
  trailing?: string;
};
type StatItem = {
  label: string;
  value: string | number | boolean | null;
  tone?: string;
};

function rowsTitled(board: Board, title: string): RowItem[] {
  const section = board.sections.find((s) => s.kind === "rows" && s.title === title);
  return section?.kind === "rows" ? (section.items as RowItem[]) : [];
}

function sectionTitles(board: Board): (string | undefined)[] {
  return board.sections.map((s) => ("title" in s ? s.title : undefined));
}

function statsItems(board: Board): StatItem[] {
  const section = board.sections.find((s) => s.kind === "stats");
  if (section?.kind !== "stats") throw new Error("no stats section");
  return section.items as StatItem[];
}

describe("buildCoordinatorBoard idle", () => {
  test("renders a valid calm board with no ledger", () => {
    const board = buildCoordinatorBoard(undefined);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.status?.label).toBe("idle");
  });
});

describe("identityTone / outcomeTone helpers", () => {
  test("coordinator and absent speaker tone brand; a slug is stable", () => {
    expect(identityTone("coordinator")).toBe("brand");
    expect(identityTone(undefined)).toBe("brand");
    expect(identityTone("atlas")).toBe(identityTone("atlas"));
  });

  test("outcomeTone reads a verify entry's verdict from its text", () => {
    expect(outcomeTone(entry({ kind: "verify", text: "review came back BLOCK" }))).toBe("error");
    expect(outcomeTone(entry({ kind: "verify", text: "checks passed" }))).toBe("ok");
    expect(outcomeTone(entry({ kind: "verify", text: "ran the gate" }))).toBe("info");
    expect(outcomeTone(entry({ kind: "replan", text: "rebuild" }))).toBe("caution");
    expect(outcomeTone(entry({ kind: "code", text: "edited" }))).toBe("accent");
  });

  test("outcomeTone: fail/block wins unless the signal word is negated (clean review)", () => {
    expect(
      outcomeTone(entry({ kind: "verify", text: "review passed (no BLOCK verdict)\nshipped" })),
    ).toBe("ok");
    expect(outcomeTone(entry({ kind: "verify", text: "all checks green, nothing failed" }))).toBe(
      "ok",
    );
    expect(
      outcomeTone(entry({ kind: "verify", text: "review came back BLOCK: unsafe cast" })),
    ).toBe("error");
    expect(
      outcomeTone(
        entry({ kind: "verify", text: "verification FAILED — bun test exit 1: 3 failing" }),
      ),
    ).toBe("error");
    expect(
      outcomeTone(entry({ kind: "verify", text: "verification FAILED: 412 pass, 1 fail" })),
    ).toBe("error");
    expect(outcomeTone(entry({ kind: "verify", text: "419 pass / 1 fail" }))).toBe("error");
  });

  test("outcomeTone respects word boundaries (no substring false-match)", () => {
    expect(outcomeTone(entry({ kind: "verify", text: "the failover node came up" }))).toBe("info");
    expect(outcomeTone(entry({ kind: "verify", text: "passport check unrelated" }))).toBe("info");
  });

  test("transcriptTrailing renders round always, provider/diff only when present", () => {
    expect(transcriptTrailing(entry({ round: 3 }))).toBe("R3");
    expect(transcriptTrailing(entry({ round: 3, provider: "claude" }))).toBe("R3 · claude");
    expect(
      transcriptTrailing(
        entry({ round: 3, provider: "claude", touched: { files: 1, insertions: 0, deletions: 0 } }),
      ),
    ).toBe("R3 · claude");
    const full = transcriptTrailing(
      entry({ round: 3, provider: "claude", touched: { files: 2, insertions: 7, deletions: 2 } }),
    );
    expect(full).toBe("R3 · claude · +7/−2");
    expect(full).toContain("−");
  });
});

describe("buildCoordinatorBoard active layout", () => {
  test("is a valid board; header carries the status pill + round chip", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 3 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("active");
    expect(board.header?.chip).toBe("round 3");
  });

  test("renders an old-shape ledger without a round budget as just the round", () => {
    const oldShapeLedger = ledger({ round: 3 });

    expect(() => buildCoordinatorBoard(oldShapeLedger)).not.toThrow();

    const board = buildCoordinatorBoard(oldShapeLedger);
    const round = statsItems(board).find((i) => i.label === "Round");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(round?.value).toBe(3);
    expect(String(round?.value)).not.toContain("/");
  });

  test("renders the round budget as n / budget when the ledger carries one", () => {
    const budgetedBoard = buildCoordinatorBoard(ledger({ round: 3, roundBudget: 6 }));
    const round = statsItems(budgetedBoard).find((i) => i.label === "Round");
    expect(canvasViewSchema.safeParse(budgetedBoard).success).toBe(true);
    expect(round?.value).toBe("3 / 6");
    expect(round?.tone).toBe("info");
  });

  test("tones the round budget stat calm early and caution at the 80% cap", () => {
    const startRound = statsItems(buildCoordinatorBoard(ledger({ round: 0, roundBudget: 6 }))).find(
      (i) => i.label === "Round",
    );
    const beforeCap = statsItems(buildCoordinatorBoard(ledger({ round: 3, roundBudget: 5 }))).find(
      (i) => i.label === "Round",
    );
    const atCap = statsItems(buildCoordinatorBoard(ledger({ round: 4, roundBudget: 5 }))).find(
      (i) => i.label === "Round",
    );

    expect(startRound?.tone).toBe("neutral");
    expect(beforeCap?.tone).toBe("info");
    expect(atCap?.tone).toBe("caution");
  });

  test("renders the goal, plan, findings, and abandoned steps", () => {
    const board = buildCoordinatorBoard(
      ledger({
        plan: ["investigate", "implement"],
        facts: ["uses bun"],
        failedSteps: ["atlas: do X"],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Goal").some((i) => i.text.includes("ship the search rib"))).toBe(
      true,
    );
    expect(rowsTitled(board, "Plan")).toHaveLength(2);
    expect(rowsTitled(board, "Findings").some((i) => i.text.includes("uses bun"))).toBe(true);
    expect(
      rowsTitled(board, "Abandoned — do not resume").some((i) => i.text.includes("atlas: do X")),
    ).toBe(true);
  });

  test("renders team-gap recommendations when the squad flags a missing specialist", () => {
    const board = buildCoordinatorBoard(ledger({ teamGaps: ["a security reviewer"] }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(
      rowsTitled(board, "Team gaps — consider casting").some((i) =>
        i.text.includes("security reviewer"),
      ),
    ).toBe(true);
  });

  test("the Ledger is the hero: round groups newest-first, speaker chips, trailing detail", () => {
    const board = buildCoordinatorBoard(
      ledger({
        round: 4,
        transcript: [
          entry({ round: 1, kind: "coordinator", text: "planning the work" }),
          entry({
            round: 2,
            kind: "code",
            speaker: "atlas",
            text: "edited the loader",
            provider: "claude",
            touched: { files: 2, insertions: 30, deletions: 4 },
            usage: { inputTokens: 9000, outputTokens: 1000 },
          }),
          entry({ round: 3, kind: "verify", text: "checks passed" }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);

    // Newest round leads and carries the Ledger title; older rounds follow.
    const titles = sectionTitles(board).filter(
      (t) => t?.startsWith("Ledger · R") || /^R\d/.test(t ?? ""),
    );
    expect(titles[0]).toContain("Ledger · R3");
    expect(titles[1]).toContain("R2");
    expect(titles[2]).toContain("R1");

    const r2 = rowsTitled(board, titles[1] ?? "");
    expect(r2[0]?.chip?.label).toBe("atlas");
    expect(r2[0]?.trailing).toContain("R2");
    expect(r2[0]?.trailing).toContain("claude");
    expect(r2[0]?.trailing).toContain("10k tok");
    expect(r2[0]?.trailing).toContain("+30/−4");
    const r3 = rowsTitled(board, titles[0] ?? "");
    expect(r3[0]?.glyph).toBe("ok");
  });

  test("the round rail renders one grid cell per round with outcome-toned badges", () => {
    const board = buildCoordinatorBoard(
      ledger({
        round: 3,
        transcript: [
          entry({ round: 0, kind: "code", speaker: "atlas", text: "edited" }),
          entry({ round: 1, kind: "verify", text: "change-quality FAILED: suppression" }),
          entry({ round: 2, kind: "replan", text: "rebuild" }),
        ],
        inFlight: { round: 3, action: "coding", speaker: "atlas" },
        status: "active",
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rail = board.sections.find((s) => s.kind === "grid");
    if (rail?.kind !== "grid") throw new Error("no round rail");
    const byLabel = new Map(rail.cells.map((c) => [c.label, c.badge]));
    expect(byLabel.get("R0")?.tone).toBe("accent");
    expect(byLabel.get("R0")?.text).toContain("atlas");
    expect(byLabel.get("R1")?.tone).toBe("error");
    expect(byLabel.get("R2")?.tone).toBe("caution");
    expect(byLabel.get("R3")?.text).toContain("now");
  });

  test("a ledger row expands to the full entry: instruction, text, and tool trace in detail", () => {
    const longText = `did the work ${"x".repeat(300)}`;
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({
            round: 0,
            kind: "code",
            speaker: "atlas",
            instruction: "edit the loader",
            text: longText,
            tools: [
              { name: "Edit", target: "src/loader.ts", ok: true },
              { name: "Bash", target: "bun test", ok: false },
            ],
          }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = board.sections
      .filter((s) => s.kind === "rows")
      .flatMap((s) => (s.kind === "rows" ? s.items : []));
    const row = rows.find((r) => r.chip?.label === "atlas") as
      | (RowItem & { detail?: string })
      | undefined;
    expect(row?.detail).toContain("instruction: edit the loader");
    expect(row?.detail).toContain(longText.slice(0, 120));
    expect(row?.detail).toContain("✓ Edit src/loader.ts");
    expect(row?.detail).toContain("✕ Bash bun test");
  });

  test("older rounds compress to a stub naming the span instead of vanishing", () => {
    const transcript = Array.from({ length: 6 }, (_, r) =>
      entry({ round: r, kind: "coordinator", text: `round ${r} thinking` }),
    );
    const board = buildCoordinatorBoard(ledger({ round: 6, transcript }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const stub = board.sections
      .filter((s) => s.kind === "rows")
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((r) => r.text.includes("earlier"));
    expect(stub?.text).toContain("R0–R2");
    expect(stub?.text).toContain("3 earlier entries");
  });

  test("gate history lists every verify entry across the run with round trailing", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({
            round: 2,
            kind: "verify",
            text: "verification passed: 5 checks",
            verdict: "pass",
          }),
          entry({ round: 2, kind: "verify", text: "change-quality FAILED: suppression" }),
          entry({
            round: 4,
            kind: "verify",
            text: "review passed (no BLOCK verdict)",
            verdict: "pass",
          }),
        ],
      }),
    );
    const gates = rowsTitled(board, "Gate history");
    expect(gates).toHaveLength(3);
    expect(gates[0]?.glyph).toBe("ok");
    expect(gates[1]?.glyph).toBe("error");
    expect(gates[1]?.trailing).toBe("R2");
  });

  test("surfaces Verification while still active (a failed done-gate keeps the run going)", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "active",
        round: 4,
        verifyFailures: 1,
        verification: {
          command: "bun test",
          exitCode: 1,
          passed: false,
          summary: "1 failing",
          atRound: 4,
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const verify = rowsTitled(board, "Verification");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.icon).toBe("✕");
  });

  test("an empty-string speaker never yields a schema-invalid empty chip label", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [{ round: 1, kind: "code", speaker: "", text: "edited", provider: "claude" }],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Worked by").every((i) => (i.chip?.label.length ?? 0) > 0)).toBe(true);
    expect(rowsTitled(board, "Transcript").every((i) => (i.chip?.label.length ?? 0) > 0)).toBe(
      true,
    );
  });

  test("omits empty sections with a bare ledger", () => {
    const board = buildCoordinatorBoard(ledger());
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Plan")).toHaveLength(0);
    expect(rowsTitled(board, "Findings")).toHaveLength(0);
    expect(rowsTitled(board, "Abandoned — do not resume")).toHaveLength(0);
    expect(rowsTitled(board, "Transcript")).toHaveLength(0);
  });
});

type CardItem = {
  title: string;
  dot?: string;
  pill?: { label: string; tone?: string };
  fields?: { label?: string; value: string | number | boolean | null }[];
  reason?: { label?: string; text: string };
};

function cardsTitled(board: Board, title: string): CardItem[] {
  const section = board.sections.find((s) => s.kind === "cards" && s.title === title);
  return section?.kind === "cards" ? (section.items as CardItem[]) : [];
}

describe("buildCoordinatorBoard in-flight card", () => {
  test("an active ledger with inFlight renders one 'In flight' card before the Transcript", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "active",
        round: 3,
        inFlight: { round: 3, speaker: "atlas", action: "coding", instruction: "edit the loader" },
        transcript: [entry({ round: 2, kind: "coordinator", text: "planning" })],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);

    const cards = cardsTitled(board, "In flight");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("atlas");
    expect(cards[0]?.pill?.label).toBe("coding");
    expect(cards[0]?.fields?.some((f) => f.value === "R3")).toBe(true);
    expect(cards[0]?.reason?.text).toContain("edit the loader");

    // "What's happening now" sits above the run history (the newest Ledger group).
    const titles = sectionTitles(board);
    const ledgerIdx = titles.findIndex((t) => t?.startsWith("Ledger"));
    expect(titles.indexOf("In flight")).toBeLessThan(ledgerIdx);
  });

  test("an in-flight turn with a live trace renders its last tools and a running marker", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "active",
        round: 2,
        inFlight: {
          round: 2,
          speaker: "atlas",
          action: "coding",
          startedAt: "2026-07-02T20:01:30.000Z",
          tools: [
            { name: "Read", target: "a.ts", ok: true },
            { name: "Edit", target: "a.ts", ok: true },
            { name: "Grep", target: "loader", ok: true },
            { name: "Bash", target: "bun test" },
          ],
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const card = cardsTitled(board, "In flight")[0];
    expect(card?.fields?.some((f) => f.label === "started" && f.value === "20:01")).toBe(true);
    expect(card?.fields?.some((f) => f.label === "tools" && f.value === 4)).toBe(true);
    // The trace rows show the LAST three calls; the unpaired final call reads as running.
    const inFlightIdx = sectionTitles(board).indexOf("In flight");
    const trace = board.sections[inFlightIdx + 1];
    if (trace?.kind !== "rows") throw new Error("no trace rows after the In flight card");
    expect(trace.items).toHaveLength(3);
    expect(trace.items[0]?.text).toBe("Edit a.ts");
    expect(trace.items[2]?.text).toBe("Bash bun test");
    expect(trace.items[2]?.trailing).toBe("running");
    expect(trace.items[2]?.icon).toBe("⟳");
  });

  test("an in-flight card with no speaker falls back to coordinator and omits a reason without instruction", () => {
    const board = buildCoordinatorBoard(
      ledger({ status: "active", inFlight: { round: 0, action: "working" } }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const cards = cardsTitled(board, "In flight");
    expect(cards[0]?.title).toBe("coordinator");
    expect(cards[0]?.reason).toBeUndefined();
  });

  test("an active ledger without inFlight renders no in-flight card", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 2 }));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(cardsTitled(board, "In flight")).toHaveLength(0);
  });

  test("a terminal ledger with a stray inFlight shows no in-flight card (guarded by status)", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "shipped it",
        inFlight: { round: 4, speaker: "atlas", action: "coding", instruction: "edit" },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(cardsTitled(board, "In flight")).toHaveLength(0);
  });
});

describe("buildCoordinatorBoard terminal layouts", () => {
  test("done leads with the Standup, shows a green Verification and worked-by", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "shipped it",
        round: 5,
        verification: {
          command: "bun test",
          exitCode: 0,
          passed: true,
          summary: "all green",
          atRound: 5,
        },
        transcript: [entry({ kind: "code", speaker: "atlas", text: "edited", provider: "claude" })],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("done");
    // A terminal board leads with the task composer (start another run), then the Standup.
    expect(sectionTitles(board)[0]).toBe("Give the squad a task");
    expect(sectionTitles(board)[1]).toBe("Standup");
    expect(rowsTitled(board, "Standup").some((i) => i.text.includes("shipped it"))).toBe(true);

    const verify = rowsTitled(board, "Verification");
    expect(verify[0]?.icon).toBe("✓");
    expect(verify[0]?.glyph).toBe("ok");
    expect(cardsTitled(board, "Minds").length).toBeGreaterThan(0);
  });

  test("a done Verification section is boxed", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "done",
        verification: { command: "bun test", exitCode: 0, passed: true, summary: "", atRound: 1 },
      }),
    );
    const section = board.sections.find((s) => s.kind === "rows" && s.title === "Verification");
    expect(section?.kind === "rows" && section.boxed).toBe(true);
  });

  test("an old-shape VerificationRecord without checks renders the fallback row", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "done",
        verification: {
          command: "bun test",
          exitCode: 1,
          passed: false,
          summary: "1 failing",
          atRound: 4,
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const verify = rowsTitled(board, "Verification");
    expect(verify).toHaveLength(1);
    expect(verify[0]?.icon).toBe("✕");
    expect(verify[0]?.glyph).toBe("error");
    expect(verify[0]?.text).toBe("bun test");
    expect(verify[0]?.trailing).toContain("exit 1");
  });

  test("max-rounds shows an Advisory + green Verification, led by the task composer", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "max-rounds",
        round: 12,
        verification: {
          command: "bun test",
          exitCode: 0,
          passed: true,
          summary: "green",
          atRound: 12,
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("max rounds");
    expect(rowsTitled(board, "Advisory").length).toBe(1);
    expect(rowsTitled(board, "Verification")[0]?.icon).toBe("✓");
    // The only actions section is the task composer (start another run); the run
    // ledger itself carries no interactive actions.
    const actions = board.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind === "actions" ? actions[0].title : undefined).toBe(
      "Give the squad a task",
    );
  });

  test("verification-failed: error pill, a red Verification row, an Advisory, no actions", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "verification-failed",
        round: 7,
        verification: {
          command: "bun run test",
          exitCode: 1,
          passed: false,
          summary: "1 fail",
          atRound: 7,
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.tone).toBe("error");
    expect(board.header?.status?.label).toBe("verification failed");

    const verify = rowsTitled(board, "Verification");
    expect(verify[0]?.icon).toBe("✕");
    expect(verify[0]?.glyph).toBe("error");
    expect(verify[0]?.trailing).toContain("exit 1");
    expect(rowsTitled(board, "Advisory").length).toBe(1);
    // The only actions section is the task composer; the failed run carries none itself.
    const actions = board.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind === "actions" ? actions[0].title : undefined).toBe(
      "Give the squad a task",
    );
  });

  test("gave-up surfaces the summary and provenance", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "gave-up",
        summary: "could not make progress",
        transcript: [
          entry({ kind: "dispatch", speaker: "vera", text: "looked", provider: "copilot" }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("gave up");
    expect(
      rowsTitled(board, "Summary").some((i) => i.text.includes("could not make progress")),
    ).toBe(true);
    expect(cardsTitled(board, "Minds").length).toBeGreaterThan(0);
  });

  test("Minds aggregates one lane per member: provider pill, turn/token counts, last act", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({
            kind: "code",
            speaker: "atlas",
            text: "edited",
            provider: "claude",
            usage: { inputTokens: 5000, outputTokens: 500 },
          }),
          entry({
            kind: "code",
            speaker: "atlas",
            text: "fixed the test",
            provider: "claude",
            usage: { inputTokens: 3000, outputTokens: 500 },
          }),
          entry({ kind: "dispatch", speaker: "vera", text: "reviewed", provider: "copilot" }),
        ],
      }),
    );
    const minds = cardsTitled(board, "Minds");
    const atlas = minds.find((c) => c.title === "atlas");
    expect(atlas?.pill?.label).toBe("claude");
    expect(atlas?.fields?.some((f) => f.label === "turns" && f.value === 2)).toBe(true);
    expect(atlas?.fields?.some((f) => f.label === "tok" && f.value === "9k")).toBe(true);
    expect(atlas?.reason?.text).toContain("fixed the test");
    const vera = minds.find((c) => c.title === "vera");
    expect(vera?.pill?.label).toBe("copilot");
    expect(vera?.fields?.some((f) => f.label === "turns" && f.value === 1)).toBe(true);
  });

  test("verify entries never become Minds lanes (the gate is the harness, not a member)", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        transcript: [
          entry({ kind: "code", speaker: "atlas", text: "edited", provider: "claude" }),
          entry({
            kind: "verify",
            speaker: "atlas, vera",
            text: "review passed (no BLOCK verdict)",
          }),
        ],
      }),
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const minds = cardsTitled(board, "Minds");
    expect(minds).toHaveLength(1);
    expect(minds[0]?.title).toBe("atlas");
  });

  test("every terminal status produces a schema-valid board", () => {
    const statuses: CoordinatorLedger["status"][] = [
      "active",
      "done",
      "gave-up",
      "max-rounds",
      "verification-failed",
      "change-quality-failed",
    ];
    for (const status of statuses) {
      const board = buildCoordinatorBoard(
        ledger({
          status,
          summary: "summary",
          verification: {
            command: "bun test",
            exitCode: 1,
            passed: false,
            summary: "x",
            atRound: 1,
          },
          transcript: [entry({ kind: "code", speaker: "atlas", text: "edit", provider: "claude" })],
        }),
      );
      expect(canvasViewSchema.safeParse(board).success).toBe(true);
    }
  });

  test("a corrupt/unknown status still yields a valid board with a neutral pill", () => {
    const forged = { ...ledger(), status: "bogus" } as unknown as CoordinatorLedger;
    const board = buildCoordinatorBoard(forged);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status?.label).toBe("unknown");
    expect(board.header?.status?.tone).toBe("neutral");
    expect(JSON.stringify(board)).toContain("Unrecognized run status: bogus");
  });
});

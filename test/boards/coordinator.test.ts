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

function rowsTitled(board: Board, title: string): RowItem[] {
  const section = board.sections.find((s) => s.kind === "rows" && s.title === title);
  return section?.kind === "rows" ? (section.items as RowItem[]) : [];
}

function sectionTitles(board: Board): (string | undefined)[] {
  return board.sections.map((s) => ("title" in s ? s.title : undefined));
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

  test("the Transcript is the hero: last section, speaker chips, R{round}/provider/diff trailing", () => {
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
          }),
          entry({ round: 3, kind: "verify", text: "checks passed" }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);

    const titles = sectionTitles(board);
    expect(titles[titles.length - 1]).toBe("Transcript");

    const rows = rowsTitled(board, "Transcript");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.chip?.label).toBe("coordinator");
    expect(rows[1]?.chip?.label).toBe("atlas");
    expect(rows[1]?.trailing).toContain("R2");
    expect(rows[1]?.trailing).toContain("claude");
    expect(rows[1]?.trailing).toContain("+30/−4");
    expect(rows[2]?.glyph).toBe("ok");
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

    // "What's happening now" sits immediately above the history.
    const titles = sectionTitles(board);
    expect(titles.indexOf("In flight")).toBeLessThan(titles.indexOf("Transcript"));
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
    expect(rowsTitled(board, "Worked by").length).toBeGreaterThan(0);
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
    expect(rowsTitled(board, "Worked by").length).toBeGreaterThan(0);
  });

  test("Worked by uses identity chips and the provider as the trailing", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({ kind: "code", speaker: "atlas", text: "edited", provider: "claude" }),
          entry({ kind: "dispatch", speaker: "vera", text: "reviewed", provider: "copilot" }),
        ],
      }),
    );
    const worked = rowsTitled(board, "Worked by");
    expect(worked.some((i) => i.chip?.label === "atlas" && i.trailing === "claude")).toBe(true);
    expect(worked.some((i) => i.chip?.label === "vera" && i.trailing === "copilot")).toBe(true);
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

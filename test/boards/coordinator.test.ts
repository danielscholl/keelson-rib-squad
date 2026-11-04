import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildCoordinatorBoard,
  identityTone,
  outcomeTone,
  RESET_SQUAD_ACTION,
  ROLLBACK_RUN_ACTION,
  STEER_COORDINATOR_ACTION,
  STOP_COORDINATOR_ACTION,
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
  person?: { name: string; tone?: string; face?: string };
  text: string;
  trailing?: string;
  detail?: string;
};
type StatItem = {
  label: string;
  value: string | number | boolean | null;
  tone?: string;
};

function rowsTitled(board: Board, title: string): RowItem[] {
  const section = board.sections.find(
    (s) => s.kind === "rows" && (s.title === title || s.title?.startsWith(`${title} · `)),
  );
  return section?.kind === "rows" ? (section.items as RowItem[]) : [];
}

function liveControls(board: Board) {
  const section = board.sections.find(
    (s) => s.kind === "actions" && s.items.some((a) => a.type === STOP_COORDINATOR_ACTION),
  );
  if (section?.kind !== "actions") throw new Error("no live controls section");
  return section;
}

function stopPayloadOf(board: Board): unknown {
  return liveControls(board).items.find((a) => a.type === STOP_COORDINATOR_ACTION)?.payload;
}

function ledgerRowsOf(board: Board): RowItem[] {
  return board.sections
    .filter(
      (s) =>
        s.kind === "rows" && (s.title?.startsWith("Ledger") || /^Round \d/.test(s.title ?? "")),
    )
    .flatMap((s) => (s.kind === "rows" ? (s.items as RowItem[]) : []));
}

function sectionTitles(board: Board): (string | undefined)[] {
  return board.sections.map((s) => ("title" in s ? s.title : undefined));
}

const VERIFICATION_ROUND_RE = /^Verification · round \d+$/;

function statsItems(board: Board): StatItem[] {
  const section = board.sections.find((s) => s.kind === "stats");
  if (section?.kind !== "stats") throw new Error("no stats section");
  return section.items as StatItem[];
}

describe("stripMd", () => {
  test("removes bold, code spans, and heading hashes but keeps identifiers and globs", async () => {
    const { stripMd } = await import("../../src/boards/coordinator.ts");
    expect(stripMd("# Edie **Personality.** `code`")).toBe("Edie Personality. code");
    expect(stripMd("rename foo_bar and run --filter '*' typecheck")).toBe(
      "rename foo_bar and run --filter '*' typecheck",
    );
  });

  test("unwraps boundary-delimited _phrase_ italics but keeps in-word underscores", async () => {
    const { stripMd } = await import("../../src/boards/coordinator.ts");
    expect(stripMd("_Cast from The Usual Suspects._ Personality.")).toBe(
      "Cast from The Usual Suspects. Personality.",
    );
    expect(stripMd("keep snake_case and __init__ files sane")).toBe(
      "keep snake_case and init files sane",
    );
  });
});

describe("charterDisplay", () => {
  test("drops the self H1 name and the cast-provenance sentence, strips markdown", async () => {
    const { charterDisplay } = await import("../../src/boards/coordinator.ts");
    expect(
      charterDisplay(
        "Keyser",
        "# Keyser\n\n_Cast from The Usual Suspects._ Personality. **Quietly** commanding.",
      ),
    ).toBe("Personality. Quietly commanding.");
    // A charter that never mentions its member is returned intact (markdown aside).
    expect(charterDisplay("Edie", "## Mission\n\nReview everything.")).toBe(
      "Mission Review everything.",
    );
  });
});

describe("buildCoordinatorBoard idle", () => {
  test("renders a valid hidden-content board with no members and no ledger", () => {
    const board = buildCoordinatorBoard(undefined);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.header?.status?.label).toBe("idle");
    expect(board.sections).toEqual([]);
  });

  test("keeps the task composer when members exist but no run ledger exists", () => {
    const board = buildCoordinatorBoard(undefined, undefined, undefined, true);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(sectionTitles(board)).toEqual(["Give the squad a task"]);
  });
});

describe("Findings narration filter", () => {
  function findings(over: Partial<CoordinatorLedger>) {
    const board = buildCoordinatorBoard(ledger({ status: "done", round: 3, ...over }));
    return rowsTitled(board, "Findings").map((r) => r.text);
  }

  test("drops a self-intro + I'll preamble, an I'll intent, and pure acknowledgments", () => {
    expect(
      findings({
        facts: [
          "Edie here. I'll ground this in the SPA code paths.",
          "I'll refactor the sync client next.",
          "Sure.",
          "(no synthesis)",
          "The retry path drops the backoff cap after the third attempt.",
        ],
      }),
    ).toEqual(["The retry path drops the backoff cap after the third attempt."]);
  });

  test("keeps a real finding that merely opens with 'Now'/'First' (no over-hiding)", () => {
    expect(findings({ facts: ["Now the auth check is missing on the delete route."] })).toContain(
      "Now the auth check is missing on the delete route.",
    );
  });
});

describe("buildCoordinatorBoard reset affordance", () => {
  function resetItem(board: Board) {
    return board.sections
      .flatMap((s) => (s.kind === "actions" ? s.items : []))
      .find((a) => a.type === RESET_SQUAD_ACTION);
  }

  test("a terminal board carries a confirm-guarded Reset squad action", () => {
    const board = buildCoordinatorBoard(ledger({ status: "done", round: 4 }), undefined, "default");
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const reset = resetItem(board);
    expect(reset?.type).toBe(RESET_SQUAD_ACTION);
    expect(reset?.destructive).toBe(true);
    expect(reset?.confirm?.title).toBe("Reset this squad?");
    // No scopeId payload: like retire-all, the handler acts on the selected scope.
    expect(reset?.payload).toBeUndefined();
  });

  test("an active run offers no Reset (Stop it first)", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 2 }));
    expect(resetItem(board)).toBeUndefined();
  });

  test("the idle board offers no Reset (nothing to clear)", () => {
    expect(resetItem(buildCoordinatorBoard(undefined))).toBeUndefined();
  });
});

describe("identityTone / outcomeTone helpers", () => {
  test("coordinator keeps brand; members resolve through the tones map, else neutral", () => {
    const tones = new Map([
      ["atlas", "id-blue" as const],
      ["edie", "id-olive" as const],
    ]);
    expect(identityTone("coordinator", tones)).toBe("brand");
    expect(identityTone(undefined, tones)).toBe("brand");
    expect(identityTone("atlas", tones)).toBe("id-blue");
    expect(identityTone("Atlas ", tones)).toBe("id-blue");
    expect(identityTone("retired-member", tones)).toBe("neutral");
    expect(identityTone("atlas")).toBe("neutral");
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

  test("transcriptTrailing carries only per-turn tokens and diff, undefined when neither", () => {
    expect(transcriptTrailing(entry({ round: 3 }))).toBeUndefined();
    expect(transcriptTrailing(entry({ round: 3, provider: "claude" }))).toBeUndefined();
    expect(
      transcriptTrailing(
        entry({ round: 3, provider: "claude", touched: { files: 1, insertions: 0, deletions: 0 } }),
      ),
    ).toBeUndefined();
    const full = transcriptTrailing(
      entry({
        round: 3,
        provider: "claude",
        touched: { files: 2, insertions: 7, deletions: 2 },
        usage: { inputTokens: 22000, outputTokens: 2000 },
      }),
    );
    expect(full).toBe("24k tok · +7 −2");
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

  test("active runs expose a confirmed destructive stop action scoped to the ledger", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 3, scopeId: "alpha" }));
    const section = liveControls(board);
    // Steer and Stop share one compact strip; Stop sits at its trailing edge.
    expect(section.title).toBeUndefined();
    expect(section.wrap).toBe(true);
    expect(section.items.map((a) => a.type)).toEqual([
      STEER_COORDINATOR_ACTION,
      STOP_COORDINATOR_ACTION,
    ]);
    const stop = section.items[1];
    expect(stop?.destructive).toBe(true);
    expect(stop?.inline).toBe(true);
    expect(stop?.align).toBe("end");
    expect(stop?.payload).toEqual({ scopeId: "alpha" });
    expect(stop?.confirm?.confirmLabel).toBe("Stop run");
    expect(section.items[0]?.payload).toEqual({ scopeId: "alpha" });
  });

  test("the active board leads with the Goal, then the pulse stats", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 3 }));
    expect(board.sections[0]?.kind === "rows" && board.sections[0].title).toBe("Goal");
    expect(board.sections[1]?.kind).toBe("stats");
  });

  test("active runs do not expose rollback", () => {
    const board = buildCoordinatorBoard(ledger({ status: "active", round: 3, scopeId: "alpha" }));
    const actions = board.sections.flatMap((s) => (s.kind === "actions" ? s.items : []));
    expect(actions.some((a) => a.type === ROLLBACK_RUN_ACTION)).toBe(false);
  });

  test("the caller's scopeId wins over the ledger's, covering pre-scopeId ledgers", () => {
    const stopPayload = stopPayloadOf;
    const legacy = buildCoordinatorBoard(ledger({ status: "active", round: 3 }), undefined, "beta");
    expect(stopPayload(legacy)).toEqual({ scopeId: "beta" });
    const stale = buildCoordinatorBoard(
      ledger({ status: "active", round: 3, scopeId: "alpha" }),
      undefined,
      "beta",
    );
    expect(stopPayload(stale)).toEqual({ scopeId: "beta" });
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

  test("renders the goal, plan, findings, and abandoned steps (plan numbered, no dots)", () => {
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
    const plan = rowsTitled(board, "Plan");
    expect(plan).toHaveLength(2);
    expect(plan.map((r) => r.icon)).toEqual(["1", "2"]);
    expect(plan.map((r) => r.text)).toEqual(["investigate", "implement"]);
    expect(plan.every((r) => r.glyph === undefined)).toBe(true);
    const findings = rowsTitled(board, "Findings");
    expect(findings.some((i) => i.text.includes("uses bun"))).toBe(true);
    expect(findings.every((r) => r.glyph === "brand")).toBe(true);
    expect(
      rowsTitled(board, "Abandoned — do not resume").some((i) => i.text.includes("atlas: do X")),
    ).toBe(true);
  });

  test("keeps no-op and member preamble turns out of Findings while leaving quiet ledger rows", () => {
    const board = buildCoordinatorBoard(
      ledger({
        facts: [
          "[team] [atlas] uses bun",
          "[team] [atlas] I will inspect the target",
          "[team] [atlas] (no synthesis)",
        ],
        transcript: [
          entry({
            round: 0,
            kind: "dispatch",
            speaker: "atlas",
            text: "[team] [atlas] I will inspect the target",
          }),
          entry({
            round: 1,
            kind: "dispatch",
            speaker: "team",
            text: "[team] [atlas] (no synthesis)",
          }),
        ],
      }),
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(statsItems(board).find((i) => i.label === "Finding")?.value).toBe(1);
    const findings = rowsTitled(board, "Findings");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toBe("atlas: uses bun");

    const ledgerRows = ledgerRowsOf(board);
    expect(ledgerRows.some((row) => row.text === "atlas: I will inspect the target")).toBe(true);
    expect(ledgerRows.some((row) => row.text === "atlas: (no synthesis)")).toBe(true);
    expect(ledgerRows.some((row) => row.text.includes("[atlas]"))).toBe(false);
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows.every((row) => row.glyph === undefined)).toBe(true);
  });

  test("normalizes bracketed speaker prefixes in visible finding rows", () => {
    const board = buildCoordinatorBoard(ledger({ facts: ["[team] [atlas] found the seam"] }));

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsTitled(board, "Findings")[0]?.text).toBe("atlas: found the seam");
  });

  test("keeps colon-prefixed findings visible — only known speaker labels strip", () => {
    const board = buildCoordinatorBoard(
      ledger({
        facts: [
          "[team] Risk: I will fail on empty input",
          "[team] src/foo.ts: I will throw when config is missing",
          "[team] [atlas] I will inspect the target",
        ],
        transcript: [
          entry({ round: 0, kind: "dispatch", speaker: "atlas", text: "grounded the seams" }),
        ],
      }),
    );

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const findings = rowsTitled(board, "Findings");
    expect(findings.some((f) => f.text.includes("Risk: I will fail on empty input"))).toBe(true);
    expect(
      findings.some((f) => f.text.includes("src/foo.ts: I will throw when config is missing")),
    ).toBe(true);
    expect(findings.some((f) => f.text.includes("I will inspect the target"))).toBe(false);
    expect(statsItems(board).find((i) => i.label === "Findings")?.value).toBe(2);
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

  test("the Ledger is the hero: round groups newest-first, speaker faces, trailing detail", () => {
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
      (t) => t?.startsWith("Ledger · round") || /^Round \d/.test(t ?? ""),
    );
    expect(titles[0]).toContain("Ledger · round 3");
    expect(titles[1]).toContain("Round 2");
    expect(titles[2]).toContain("Round 1");

    const r2 = rowsTitled(board, titles[1] ?? "");
    expect(r2[0]?.chip).toBeUndefined();
    expect(r2[0]?.glyph).toBeUndefined();
    expect(r2[0]?.person).toEqual({ name: "atlas", tone: "neutral", face: "A" });
    expect(r2[0]?.trailing).toBe("10k tok · +30 −4");
    const r3 = rowsTitled(board, titles[0] ?? "");
    expect(r3[0]?.person).toBeUndefined();
    expect(r3[0]?.glyph).toBe("ok");
    const r1 = rowsTitled(board, titles[2] ?? "");
    expect(r1[0]?.person).toEqual({ name: "coordinator", tone: "brand", face: "◆" });
  });

  test("the round rail names event and member, toned by identity; gate red and re-plan stay status", () => {
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
      new Map([["atlas", "id-teal" as const]]),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rail = board.sections.find((s) => s.kind === "grid");
    if (rail?.kind !== "grid") throw new Error("no round rail");
    const byLabel = new Map(rail.cells.map((c) => [c.label, c.badge]));
    expect(byLabel.get("R0")?.tone).toBe("id-teal");
    expect(byLabel.get("R0")?.text).toBe("code · atlas");
    expect(byLabel.get("R1")?.text).toBe("gate · atlas ✕");
    expect(byLabel.get("R1")?.tone).toBe("error");
    expect(byLabel.get("R2")?.tone).toBe("caution");
    expect(byLabel.get("R2")?.text).toBe("re-plan · coordinator");
    expect(byLabel.get("R3")?.text).toBe("▶ code · atlas");
    // Without a tones map the member cell folds to neutral — never a hash.
    const bare = buildCoordinatorBoard(
      ledger({
        round: 1,
        transcript: [entry({ round: 0, kind: "code", speaker: "atlas", text: "edited" })],
        status: "active",
      }),
    );
    const bareRail = bare.sections.find((s) => s.kind === "grid");
    if (bareRail?.kind !== "grid") throw new Error("no round rail");
    expect(bareRail.cells[0]?.badge?.tone).toBe("neutral");
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
    const row = ledgerRowsOf(board).find((r) => r.person?.name === "atlas");
    expect(row?.detail).toContain("instruction: edit the loader");
    expect(row?.detail).toContain(longText.slice(0, 120));
    expect(row?.detail).toContain("✓ Edit src/loader.ts");
    expect(row?.detail).toContain("✕ Bash bun test");
  });

  test("the Ledger leaves out the gate the Verification section already reports", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        round: 2,
        transcript: [
          entry({ round: 1, kind: "code", speaker: "atlas", text: "edited" }),
          entry({
            round: 2,
            kind: "verify",
            text: "verification passed: bun test",
            verdict: "pass",
          }),
        ],
        verification: {
          atRound: 2,
          passed: true,
          command: "bun test",
          exitCode: 0,
          summary: "",
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const titles = board.sections.map((s) => s.title);
    expect(titles).toContain("Verification · round 2");
    expect(titles).toContain("Ledger · round 1");
    expect(titles.some((t) => t?.includes("round 2") && t.startsWith("Ledger"))).toBe(false);
  });

  test("an active run shows Stalls only once one happens", () => {
    const quiet = buildCoordinatorBoard(ledger({ round: 2 }));
    expect(statsItems(quiet).some((i) => i.label.startsWith("Stall"))).toBe(false);
    const stuck = buildCoordinatorBoard(ledger({ round: 2, stallCount: 1 }));
    expect(statsItems(stuck).find((i) => i.label === "Stall")?.value).toBe(1);
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
    expect(stub?.text).toBe("Rounds 0–2 · 3 earlier entries");
    // A live run isn't in Runs yet, so the stub doesn't point there; its detail lists them.
    expect(stub?.trailing).toBeUndefined();
    expect(stub?.detail).toBe(
      "R2 · coordinator: round 2 thinking\nR1 · coordinator: round 1 thinking\nR0 · coordinator: round 0 thinking",
    );
    const settled = buildCoordinatorBoard(ledger({ status: "done", round: 6, transcript }));
    const settledStub = settled.sections
      .flatMap((s) => (s.kind === "rows" ? s.items : []))
      .find((r) => r.text.includes("earlier"));
    expect(settledStub?.trailing).toBe("full run in Runs");
  });

  test("a gate row shows its verdict, not the command chain it ran", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({
            round: 1,
            kind: "verify",
            text: "verification FAILED: bun run typecheck (exit 2)\nsrc/a.ts: bad type",
          }),
          entry({
            round: 2,
            kind: "verify",
            text: "verification passed: bun run check && bun test",
            verdict: "pass",
          }),
        ],
      }),
    );
    const ledgerGates = ledgerRowsOf(board).filter((r) => r.glyph !== undefined);
    expect(ledgerGates.map((r) => r.text)).toEqual([
      "verification passed",
      "bun run typecheck failed · exit 2 · src/a.ts: bad type",
    ]);
    expect(ledgerGates.map((r) => r.glyph)).toEqual(["ok", "error"]);
    expect(ledgerGates.every((r) => r.person === undefined && r.chip === undefined)).toBe(true);
    expect(ledgerGates[1]?.detail).toContain("src/a.ts: bad type");
    // Both gates sit in Ledger rounds on screen, so Gate history has nothing to add.
    expect(rowsTitled(board, "Gate history")).toEqual([]);
  });

  test("a lone green gate leaves Gate history out; Verification already says it", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [
          entry({
            round: 2,
            kind: "verify",
            text: "verification passed: bun test",
            verdict: "pass",
          }),
        ],
      }),
    );
    expect(rowsTitled(board, "Gate history")).toEqual([]);
  });

  test("gate history lists the gates scrolled out of the Ledger, with round trailing", () => {
    const board = buildCoordinatorBoard(
      ledger({
        round: 7,
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
          entry({ round: 5, kind: "coordinator", text: "next" }),
          entry({ round: 6, kind: "coordinator", text: "next" }),
          entry({ round: 7, kind: "coordinator", text: "next" }),
        ],
      }),
    );
    const gates = rowsTitled(board, "Gate history");
    expect(gates).toHaveLength(3);
    expect(gates[0]?.glyph).toBe("ok");
    expect(gates[1]?.glyph).toBe("error");
    expect(gates[1]?.trailing).toBe("round 2");
    expect(gates.every((g) => g.icon === undefined)).toBe(true);
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
    expect(verify[0]?.icon).toBeUndefined();
    expect(verify[0]?.glyph).toBe("error");
  });

  test("an empty-string speaker never yields a schema-invalid empty person name", () => {
    const board = buildCoordinatorBoard(
      ledger({
        transcript: [{ round: 1, kind: "code", speaker: "", text: "edited", provider: "claude" }],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const rows = ledgerRowsOf(board);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.person?.name).toBe("coordinator");
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
  edge?: string;
  pill?: { label: string; tone?: string };
  fields?: {
    label?: string;
    value?: string | number | boolean | null;
    clock?: { at: string; mode: string };
  }[];
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
    expect(cards[0]?.pill).toEqual({ label: "coding", tone: "info" });
    expect(cards[0]?.edge).toBe("neutral");
    expect(cards[0]?.fields?.some((f) => f.label === "round")).toBe(false);
    expect(cards[0]?.reason).toEqual({ text: "edit the loader" });

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
    expect(card?.fields?.find((f) => f.label === "started")?.clock).toEqual({
      at: "2026-07-02T20:01:30.000Z",
      mode: "since",
    });
    expect(card?.fields?.some((f) => f.label === "tool calls" && f.value === 4)).toBe(true);
    // The trace rows show the LAST three calls; the unpaired final call reads as running.
    const inFlightIdx = sectionTitles(board).indexOf("In flight");
    const trace = board.sections[inFlightIdx + 1];
    if (trace?.kind !== "rows") throw new Error("no trace rows after the In flight card");
    expect(trace.items).toHaveLength(3);
    expect(trace.items[0]?.text).toBe("Edit a.ts");
    expect(trace.items[2]?.text).toBe("Bash bun test");
    expect(trace.items[2]?.trailing).toBe("running");
    expect(trace.items[2]?.glyph).toBe("info");
    expect(trace.items.every((t) => t.icon === undefined)).toBe(true);
    expect(trace.items[0]?.trailing).toBeUndefined();
  });

  test("a failed trace call reads as failed", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "active",
        inFlight: {
          round: 1,
          action: "coding",
          tools: [
            { name: "Bash", target: "bun test", ok: false },
            { name: "Read", target: "a.ts" },
          ],
        },
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const inFlightIdx = sectionTitles(board).indexOf("In flight");
    const trace = board.sections[inFlightIdx + 1];
    if (trace?.kind !== "rows") throw new Error("no trace rows after the In flight card");
    expect(trace.items[0]?.glyph).toBe("error");
    expect(trace.items[0]?.trailing).toBe("failed");
    expect(trace.items[1]?.trailing).toBe("running");
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
  test("done leads with the Goal and Standup, shows a green Verification and Minds", () => {
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
    // A settled board reads its result first (Goal, stats, Standup), then offers the
    // next task.
    expect(sectionTitles(board).slice(0, 3)).toEqual(["Goal", undefined, "Standup"]);
    const body = sectionTitles(board).filter((t) => t && !t.startsWith("Ledger"));
    expect(body).toEqual([
      "Goal",
      "Standup",
      "Verification · round 5",
      "Minds",
      "Give the squad a task",
    ]);
    const standup = rowsTitled(board, "Standup");
    expect(standup.some((i) => i.text.includes("shipped it"))).toBe(true);
    expect(standup[0]?.glyph).toBe("ok");
    expect(standup[0]?.icon).toBeUndefined();

    const verify = rowsTitled(board, "Verification");
    expect(verify[0]?.icon).toBeUndefined();
    expect(verify[0]?.glyph).toBe("ok");
    expect(verify[0]?.trailing).toBe("passed");
    expect(rowsTitled(board, "Minds").length).toBeGreaterThan(0);
  });

  test("done orders Goal, stats, Standup, Findings, Verification, Gate history, Minds, Ledger", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "shipped it",
        round: 2,
        facts: ["the retry path drops its cap"],
        verification: { command: "bun test", exitCode: 0, passed: true, summary: "", atRound: 2 },
        transcript: [
          entry({ round: 1, kind: "code", speaker: "atlas", text: "edited", provider: "claude" }),
          entry({ round: 1, kind: "verify", text: "verification FAILED: bun test (exit 1)" }),
          entry({ round: 2, kind: "verify", text: "checks passed", verdict: "pass" }),
          entry({ round: 3, kind: "coordinator", text: "wrap" }),
          entry({ round: 4, kind: "coordinator", text: "wrap" }),
          entry({ round: 5, kind: "coordinator", text: "wrap" }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const titles = sectionTitles(board).map((t) =>
      t && VERIFICATION_ROUND_RE.test(t) ? "Verification" : t,
    );
    expect(board.sections[titles.indexOf("Goal") + 1]?.kind).toBe("stats");
    const order = ["Goal", "Standup", "Findings", "Verification", "Gate history", "Minds"].map(
      (t) => titles.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const ledgerIdx = titles.findIndex((t) => t?.startsWith("Ledger"));
    expect(ledgerIdx).toBeGreaterThan(order.at(-1) ?? -1);
  });

  test("a done Verification section is a plain row list, not boxed", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "done",
        summary: "done",
        verification: { command: "bun test", exitCode: 0, passed: true, summary: "", atRound: 1 },
      }),
    );
    const section = board.sections.find(
      (s) => s.kind === "rows" && VERIFICATION_ROUND_RE.test(s.title ?? ""),
    );
    expect(section?.kind).toBe("rows");
    expect(section?.kind === "rows" && section.boxed).toBeFalsy();
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
    expect(verify[0]?.icon).toBeUndefined();
    expect(verify[0]?.glyph).toBe("error");
    expect(verify[0]?.text).toBe("bun test");
    expect(verify[0]?.trailing).toBe("exit 1 · 1 failing");
  });

  test("max-rounds shows an Advisory + green Verification, then the task composer", () => {
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
    expect(rowsTitled(board, "Verification")[0]?.glyph).toBe("ok");
    // A terminal board ends with two actions sections, the task composer (start another
    // run) and then the teardown verb; the run ledger itself carries no interactive actions.
    const actions = board.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(2);
    const composer = actions[0];
    expect(composer?.kind === "actions" ? composer.title : undefined).toBe("Give the squad a task");
    expect(composer?.kind === "actions" ? composer.tabs : undefined).toBe(true);
    const reset = actions.at(-1);
    expect(reset?.kind === "actions" ? reset.title : "titled").toBeUndefined();
    expect(reset?.kind === "actions" ? reset.wrap : undefined).toBe(true);
    expect(reset?.kind === "actions" ? reset.items[0]?.type : undefined).toBe(RESET_SQUAD_ACTION);
  });

  test("max-tokens shows a caution pill and token-budget advisory", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "max-tokens",
        round: 4,
        summary: "Token budget reached (12k ≥ 10k).",
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status).toEqual({ label: "max tokens", tone: "caution" });
    expect(rowsTitled(board, "Advisory")[0]?.text).toContain("token budget");
  });

  test("verification-failed: error pill, a red Verification row, an Advisory, and rollback", () => {
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
    expect(verify[0]?.icon).toBeUndefined();
    expect(verify[0]?.glyph).toBe("error");
    expect(verify[0]?.trailing).toContain("exit 1");
    expect(rowsTitled(board, "Advisory").length).toBe(1);
    const rollbackSection = board.sections.find(
      (s) => s.kind === "actions" && s.items.some((a) => a.type === ROLLBACK_RUN_ACTION),
    );
    expect(rollbackSection?.kind === "actions" ? rollbackSection.title : "titled").toBeUndefined();
    expect(rollbackSection?.kind === "actions" ? rollbackSection.wrap : undefined).toBe(true);
    const rollback = board.sections
      .flatMap((s) => (s.kind === "actions" ? s.items : []))
      .find((a) => a.type === ROLLBACK_RUN_ACTION);
    expect(rollback?.destructive).toBe(true);
    expect(rollback?.payload).toEqual({
      run: "2026-06-28T00-00-00-000Z",
      confirm: false,
      scopeId: "default",
    });
    expect(rollback?.confirm?.body).toContain("C/M/D manifest");
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
    expect(rowsTitled(board, "Minds").length).toBeGreaterThan(0);
  });

  test("aborted is a calm terminal state with an intact transcript", () => {
    const board = buildCoordinatorBoard(
      ledger({
        status: "aborted",
        transcript: [entry({ kind: "dispatch", speaker: "atlas", text: "partially done" })],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status).toEqual({ label: "aborted", tone: "neutral" });
    expect(rowsTitled(board, "Advisory")[0]?.glyph).toBe("neutral");
    expect(
      rowsTitled(board, "Ledger · round 0").some((i) => i.text.includes("partially done")),
    ).toBe(true);
  });

  test("rollback appears only on aborted and failed terminal runs", () => {
    const rollbackStatuses: CoordinatorLedger["status"][] = [
      "aborted",
      "verification-failed",
      "change-quality-failed",
    ];
    const noRollbackStatuses: CoordinatorLedger["status"][] = [
      "active",
      "done",
      "gave-up",
      "max-rounds",
      "max-tokens",
    ];
    const hasRollback = (status: CoordinatorLedger["status"]) => {
      const board = buildCoordinatorBoard(ledger({ status, scopeId: "alpha" }), undefined, "beta");
      return board.sections
        .flatMap((s) => (s.kind === "actions" ? s.items : []))
        .some((a) => a.type === ROLLBACK_RUN_ACTION);
    };

    for (const status of rollbackStatuses) expect(hasRollback(status)).toBe(true);
    for (const status of noRollbackStatuses) expect(hasRollback(status)).toBe(false);
  });

  test("Minds summarizes each member: face, turns and rounds, provider + token split", () => {
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
            round: 2,
            usage: { inputTokens: 3000, outputTokens: 500 },
          }),
          entry({ kind: "dispatch", speaker: "vera", text: "reviewed", provider: "copilot" }),
        ],
      }),
    );
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    const minds = rowsTitled(board, "Minds");
    const atlas = minds.find((r) => r.person?.name === "atlas");
    expect(atlas?.person?.face).toBe("A");
    expect(atlas?.text).toBe("2 turns · rounds 0, 2");
    expect(atlas?.trailing).toBe("claude · 8k in · 1k out");
    expect(atlas?.detail).toBeUndefined();
    const vera = minds.find((r) => r.person?.name === "vera");
    expect(vera?.text).toBe("1 turn · round 0");
    expect(vera?.trailing).toBe("copilot");
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
    const minds = rowsTitled(board, "Minds");
    expect(minds).toHaveLength(1);
    expect(minds[0]?.person?.name).toBe("atlas");
  });

  test("every terminal status produces a schema-valid board", () => {
    const statuses: CoordinatorLedger["status"][] = [
      "active",
      "done",
      "gave-up",
      "max-rounds",
      "max-tokens",
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

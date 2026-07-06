import { describe, expect, test } from "bun:test";
import { DESIGN_TOKENS, validateCategoricalPalette } from "@keelson/shared";
import type { CoordinatorLedger } from "../src/coordinator.ts";
import { buildRunReportHtml, reportSummaryLine } from "../src/report.ts";
import type { Member } from "../src/types.ts";

const member = (slug: string, name: string, slot: number): Member => ({
  slug,
  name,
  role: "engineer",
  charter: `# ${name}`,
  status: "active",
  identitySlot: slot,
});

const ledger = (over: Partial<CoordinatorLedger> = {}): CoordinatorLedger => ({
  task: "Ship the **run report** feature",
  facts: ["report page renders offline", "identity palette validated"],
  plan: ["build", "verify"],
  round: 4,
  stallCount: 0,
  resetCount: 0,
  status: "done",
  summary: "shipped",
  transcript: [
    {
      round: 1,
      kind: "coordinator",
      text: "plan: build then verify",
      usage: { inputTokens: 900, outputTokens: 100 },
    },
    {
      round: 1,
      kind: "code",
      speaker: "edie",
      text: "edited the builder",
      provider: "copilot",
      usage: { inputTokens: 4000, outputTokens: 1000 },
      touched: { files: 2, insertions: 40, deletions: 3 },
    },
    {
      round: 2,
      kind: "dispatch",
      speaker: "mcmanus",
      text: "reviewed the diff",
      provider: "claude",
      usage: { inputTokens: 1500, outputTokens: 500 },
    },
    { round: 3, kind: "verify", text: "verification passed: 2 checks", verdict: "pass" },
  ],
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T11:30:00.000Z",
  ...over,
});

// mcmanus deliberately carries the EARLIER slot so cast order (not transcript
// order, not token order) decides the member section's row order.
const members = [member("mcmanus", "McManus", 0), member("edie", "Edie", 1)];

const html = buildRunReportHtml(ledger(), {
  runId: "2026-07-01T10-00-00-000Z",
  members,
  generatedAt: "2026-07-06T00:00:00.000Z",
});

const IDENTITY_ORDER = ["blue", "amber", "teal", "rose", "olive"] as const;

describe("buildRunReportHtml", () => {
  test("masthead carries the eyebrow, the stripped task, the status, and the date window", () => {
    expect(html).toContain("SQUAD RUN REPORT");
    expect(html).toContain("Ship the run report feature");
    expect(html).not.toContain("**run report**");
    expect(html).toContain(">done</span>");
    expect(html).toContain("2026-07-01 10:00");
    expect(html).toContain("2026-07-01 11:30");
  });

  test("stat tiles report rounds, total tokens, members, and findings", () => {
    for (const label of ["rounds", "total tokens", "members", "findings"]) {
      expect(html).toContain(`<div class="label">${label}</div>`);
    }
    // 900+100 + 4000+1000 + 1500+500 = 8000 -> "8k".
    expect(html).toContain('<div class="value">8k</div>');
    expect(html).toContain('<div class="value">4</div>');
  });

  test("member rows follow cast order and wear identity-hue vars with token bars", () => {
    expect(html.indexOf("McManus")).toBeGreaterThan(-1);
    expect(html.indexOf("McManus")).toBeLessThan(html.indexOf("Edie"));
    // Slot 0 (mcmanus) wears --id-blue, slot 1 (edie) --id-amber — via var(), never hex.
    expect(html).toContain("--hue: var(--id-blue)");
    expect(html).toContain("--hue: var(--id-amber)");
    // Edie carries the most member tokens (5000) so her bar is the full track.
    expect(html).toContain('width: 100%"');
    expect(html).toContain("5k tok");
    expect(html).toContain("2k tok");
  });

  test("the round timeline lists every entry with round, speaker, summary, and tokens", () => {
    expect(html).toContain('class="scroll"');
    expect(html).toContain(">r1</td>");
    expect(html).toContain(">r3</td>");
    expect(html).toContain("edited the builder");
    expect(html).toContain("reviewed the diff");
    expect(html).toContain(">coordinator</span>");
    expect(html).toContain(">verify</span>");
    expect(html).toContain(">—</td>");
  });

  test("findings render as a list; the provenance footer names run id and generated-at", () => {
    expect(html).toContain("report page renders offline");
    expect(html).toContain("identity palette validated");
    expect(html).toContain("run 2026-07-01T10-00-00-000Z");
    expect(html).toContain("generated 2026-07-06T00:00:00.000Z");
    expect(html).toContain("composed deterministically from the run ledger");
  });

  test("data-palette attrs declare the DESIGN_TOKENS identity hexes in cast order", () => {
    const dark = /data-palette-dark="([^"]+)"/.exec(html)?.[1];
    const light = /data-palette-light="([^"]+)"/.exec(html)?.[1];
    expect(dark).toBe(IDENTITY_ORDER.map((k) => DESIGN_TOKENS.dark.identity[k]).join(","));
    expect(light).toBe(IDENTITY_ORDER.map((k) => DESIGN_TOKENS.light.identity[k]).join(","));
  });

  test("the declared identity palettes pass validateCategoricalPalette in both modes", () => {
    const dark = (/data-palette-dark="([^"]+)"/.exec(html)?.[1] ?? "").split(",");
    const light = (/data-palette-light="([^"]+)"/.exec(html)?.[1] ?? "").split(",");
    expect(validateCategoricalPalette(dark, { mode: "dark" }).ok).toBe(true);
    expect(validateCategoricalPalette(light, { mode: "light" }).ok).toBe(true);
  });

  test("hex appears only in token custom-prop declarations, never in component CSS or markup", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(style.length).toBeGreaterThan(0);
    for (const line of style.split("\n")) {
      if (!/#[0-9a-fA-F]{3,8}\b/.test(line)) continue;
      expect(line).toMatch(/^\s*(--[a-z0-9-]+:\s*#[0-9a-fA-F]{6};\s*)+$/);
    }
    const markup = html
      .replace(/<style>[\s\S]*?<\/style>/, "")
      .replace(/data-palette-(dark|light)="[^"]*"/g, "");
    expect(markup).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  test("token blocks cover both themes so the host's data-theme stamp rethemes the page", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(style).toContain(':root[data-theme="light"]');
    expect(style).toContain("--id-blue:");
    expect(style).toContain("font-variant-numeric: tabular-nums");
  });

  test("ledger text is HTML-escaped before it reaches the page", () => {
    const evil = buildRunReportHtml(
      ledger({ task: '<script>alert("x")</script>', facts: ['<img src="x" onerror="y">'] }),
      { runId: "r", members: [] },
    );
    expect(evil).not.toContain("<script>alert");
    expect(evil).not.toContain("<img src=");
    expect(evil).toContain("&lt;script&gt;");
  });

  test("a speaker with no roster record folds to the muted hue after cast members", () => {
    const withStranger = ledger({
      transcript: [
        ...ledger().transcript,
        { round: 4, kind: "dispatch", speaker: "drifter", text: "chimed in" },
      ],
    });
    const page = buildRunReportHtml(withStranger, { runId: "r", members });
    expect(page.indexOf("Edie")).toBeLessThan(page.indexOf("drifter"));
    expect(page).toContain("--hue: var(--muted)");
  });
});

describe("reportSummaryLine", () => {
  test("summarizes status, rounds, tokens, members, and findings on one line", () => {
    expect(reportSummaryLine(ledger())).toBe("done · 4 rounds · 8k tok · 2 members · 2 findings");
  });
});

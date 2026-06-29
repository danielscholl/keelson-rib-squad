import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldThemedCharter } from "../src/casting/registry.ts";
import {
  buildSeedFor,
  composeMemberSystemPrompt,
  ENTER_OPENING_PROMPT,
  MEMBER_PROMPT_BUDGET,
} from "../src/compose.ts";
import { type MemberRecord, scaffoldMember } from "../src/member-store.ts";
import type { Member } from "../src/types.ts";

let root: string;

const record = (over: Partial<MemberRecord> = {}): MemberRecord => ({
  slug: "scout",
  name: "Scout",
  role: "Researcher",
  charter: "# Scout\n\nDigs up facts.",
  status: "active",
  createdAt: "2026-06-06T00:00:00.000Z",
  ...over,
});

const member = (over: Partial<Member> = {}): Member => ({
  slug: "scout",
  name: "Scout",
  role: "Researcher",
  charter: "Digs up facts.",
  status: "active",
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-compose-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("composeMemberSystemPrompt", () => {
  test("stacks the charter identity and the direct-chat footer", async () => {
    await scaffoldMember(
      root,
      record({ charter: "# Scout\n\nI am Scout, a relentless researcher." }),
    );
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("relentless researcher");
    expect(prompt).toContain("## Direct-chat operating rules");
    expect(prompt).toContain("greet the operator");
  });

  test("omits template memory and rules sections for a fresh member", async () => {
    await scaffoldMember(root, record());
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt).not.toContain("## Durable memory");
    expect(prompt).not.toContain("## Operating rules");
    expect(prompt).toContain("## Recent log"); // the genesis log line is real substance
  });

  test("keeps real memory content even when it uses an italic parenthetical", async () => {
    await scaffoldMember(root, record());
    await writeFile(
      join(root, "scout", "memory.md"),
      "# Working memory\n\n_(launch ships Friday)_",
    );
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt).toContain("## Durable memory");
    expect(prompt).toContain("launch ships Friday");
  });

  test("includes memory and rules once they carry substance", async () => {
    await scaffoldMember(root, record());
    await writeFile(
      join(root, "scout", "memory.md"),
      "# Working memory\n\nPrefers primary sources.",
    );
    await writeFile(join(root, "scout", "rules.md"), "# Rules\n\nNever pad a thin answer.");
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt).toContain("## Durable memory");
    expect(prompt).toContain("Prefers primary sources.");
    expect(prompt).toContain("## Operating rules");
    expect(prompt).toContain("Never pad a thin answer.");
  });

  test("a cast member's folded charter carries the character voice into the prompt", async () => {
    await scaffoldMember(
      root,
      record({
        name: "McManus",
        charter: foldThemedCharter("# Atlas\n\n## Mission\n\nShip the search rib.", {
          name: "McManus",
          personality: "Bold and direct; ships fast.",
          backstory: "The hotshot operator who dives in headfirst.",
          themeLabel: "The Usual Suspects",
        }),
      }),
    );
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt).toContain("Cast from The Usual Suspects");
    expect(prompt).toContain("Bold and direct");
    expect(prompt).toContain("The hotshot operator");
    expect(prompt).toContain("Ship the search rib.");
  });

  test("falls back to the record's charter when charter.md is missing", async () => {
    // no scaffold — the members dir doesn't exist at all
    const prompt = await composeMemberSystemPrompt(root, member({ charter: "Fallback identity." }));
    expect(prompt).toContain("Fallback identity.");
    expect(prompt).toContain("## Direct-chat operating rules");
  });

  test("an unsafe slug degrades to the charter fallback without throwing", async () => {
    const prompt = await composeMemberSystemPrompt(
      root,
      member({ slug: "../escape", charter: "Safe." }),
    );
    expect(prompt).toContain("Safe.");
  });

  test("a giant log is tail-truncated and the result stays within budget", async () => {
    await scaffoldMember(root, record());
    const huge = `# Log\n\n${"old filler line\n".repeat(2000)}MOST_RECENT_ENTRY\n`;
    await writeFile(join(root, "scout", "log.md"), huge);
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt.length).toBeLessThanOrEqual(MEMBER_PROMPT_BUDGET);
    expect(prompt).toContain("MOST_RECENT_ENTRY"); // the tail survives
    expect(prompt).toContain("## Identity"); // identity is never dropped
  });

  test("a giant charter alone is clamped within budget", async () => {
    await scaffoldMember(root, record({ charter: `# Scout\n\n${"x".repeat(20000)}` }));
    const prompt = await composeMemberSystemPrompt(root, member());
    expect(prompt.length).toBeLessThanOrEqual(MEMBER_PROMPT_BUDGET);
    expect(prompt).toContain("## Direct-chat operating rules");
  });
});

describe("buildSeedFor", () => {
  test("returns a seed with the composed prompt, clamped name, and opener", async () => {
    await scaffoldMember(root, record());
    const seed = await buildSeedFor(root, member());
    expect(seed.systemPrompt).toContain("## Identity");
    expect(seed.systemPrompt.length).toBeLessThanOrEqual(MEMBER_PROMPT_BUDGET);
    expect(seed.name).toBe("Scout");
    expect(seed.openingPrompt).toBe(ENTER_OPENING_PROMPT);
  });

  test("clamps an over-long name to 80 chars", async () => {
    const seed = await buildSeedFor(root, member({ name: "N".repeat(120) }));
    expect(seed.name.length).toBe(80);
  });

  test("carries the member's model only alongside its provider (provider-primary)", async () => {
    expect((await buildSeedFor(root, member())).model).toBeUndefined();
    // A model needs its provider — a model-only member omits the model from the seed.
    expect(
      (await buildSeedFor(root, member({ model: "claude-sonnet-4-6" }))).model,
    ).toBeUndefined();
    // With both pinned, the model rides through.
    expect(
      (await buildSeedFor(root, member({ provider: "anthropic", model: "claude-sonnet-4-6" })))
        .model,
    ).toBe("claude-sonnet-4-6");
  });

  test("carries the member's provider as providerId when set, omits it otherwise", async () => {
    expect((await buildSeedFor(root, member())).providerId).toBeUndefined();
    expect((await buildSeedFor(root, member({ provider: "anthropic" }))).providerId).toBe(
      "anthropic",
    );
  });
});

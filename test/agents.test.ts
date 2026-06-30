import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents, resolveAgent } from "../src/agents.ts";
import { type MemberRecord, scaffoldMember } from "../src/member-store.ts";
import { scopeMembersDir, setSquadDataHome } from "../src/paths.ts";

const record = (over: { slug: string; name: string }): MemberRecord => ({
  slug: over.slug,
  name: over.name,
  role: "Engineer",
  charter: `# ${over.name}\n\n## Role\n\nBuilds ${over.name}.`,
  status: "active",
  createdAt: "2026-06-27T00:00:00.000Z",
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-agents-"));
  setSquadDataHome(home);
});
afterEach(async () => {
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("cross-scope chat agents", () => {
  test("a member cast under a project scope appears in listAgents and resolves", async () => {
    await scaffoldMember(scopeMembersDir(home, "default"), record({ slug: "lead", name: "Lead" }));
    await scaffoldMember(scopeMembersDir(home, "alpha"), record({ slug: "atlas", name: "Atlas" }));

    const slugs = (await listAgents()).map((a) => a.slug);
    expect(slugs).toContain("lead");
    expect(slugs).toContain("atlas");

    // A per-project member resolves to its seed (sourced from the scope it lives in).
    const seed = await resolveAgent("atlas");
    expect(seed?.name).toBe("Atlas");
    expect(seed?.systemPrompt).toContain("Atlas");
  });

  test("only the default scope: behavior is unchanged", async () => {
    await scaffoldMember(scopeMembersDir(home, "default"), record({ slug: "lead", name: "Lead" }));
    expect((await listAgents()).map((a) => a.slug)).toEqual(["lead"]);
    expect((await resolveAgent("lead"))?.name).toBe("Lead");
    expect(await resolveAgent("ghost")).toBeNull();
  });

  test("two scopes casting the same slug surface ONE deduped agent; default scope wins", async () => {
    await scaffoldMember(
      scopeMembersDir(home, "default"),
      record({ slug: "atlas", name: "Default Atlas" }),
    );
    await scaffoldMember(
      scopeMembersDir(home, "alpha"),
      record({ slug: "atlas", name: "Alpha Atlas" }),
    );

    // Deduped by slug: ONE atlas card, not a confusing pair on /api/agents.
    const atlasEntries = (await listAgents()).filter((a) => a.slug === "atlas");
    expect(atlasEntries).toHaveLength(1);
    expect(atlasEntries[0]?.name).toBe("Default Atlas");
    // resolveAgent is deterministic over the same precedence (default scope first).
    expect((await resolveAgent("atlas"))?.name).toBe("Default Atlas");
  });

  test("deterministic across project scopes: lowest-sorted segment wins (no default member)", async () => {
    await scaffoldMember(
      scopeMembersDir(home, "zeta"),
      record({ slug: "atlas", name: "Zeta Atlas" }),
    );
    await scaffoldMember(
      scopeMembersDir(home, "alpha"),
      record({ slug: "atlas", name: "Alpha Atlas" }),
    );
    // Sorted project order: "alpha" precedes "zeta".
    expect((await resolveAgent("atlas"))?.name).toBe("Alpha Atlas");
    expect((await listAgents()).filter((a) => a.slug === "atlas")).toHaveLength(1);
  });
});

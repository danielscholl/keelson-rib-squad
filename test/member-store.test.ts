import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasViewSchema } from "@keelson/shared";
import { buildRosterBoard } from "../src/boards/roster.ts";
import {
  appendLog,
  LOG_ENTRY_CAP,
  LOG_MAX_ENTRIES,
  listMemberRecords,
  MEMORY_DOC_CAP,
  type MemberRecord,
  readMember,
  readMemberDoc,
  readMembers,
  retireMember,
  scaffoldMember,
  scaffoldRoster,
  setMemberModel,
  writeMemory,
} from "../src/member-store.ts";

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-members-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scaffoldMember", () => {
  test("writes the founding documents", async () => {
    await scaffoldMember(root, record());
    const dir = join(root, "scout");
    const charter = await readFile(join(dir, "charter.md"), "utf8");
    expect(charter).toContain("Digs up facts.");
    const meta = JSON.parse(await readFile(join(dir, "member.json"), "utf8")) as MemberRecord;
    expect(meta.name).toBe("Scout");
    expect(meta.status).toBe("active");
    for (const f of ["charter.md", "memory.md", "rules.md", "log.md"]) {
      expect((await readFile(join(dir, f), "utf8")).length).toBeGreaterThan(0);
    }
  });

  test("refuses to clobber an existing member (fail closed)", async () => {
    await scaffoldMember(root, record());
    await expect(scaffoldMember(root, record())).rejects.toThrow(/already exists/);
  });

  test("rejects an unsafe slug", async () => {
    await expect(scaffoldMember(root, record({ slug: "../escape" }))).rejects.toThrow();
  });
});

describe("readMembers", () => {
  test("returns the chat-facing member shape, newest first", async () => {
    await scaffoldMember(root, record({ createdAt: "2026-01-01T00:00:00.000Z" }));
    await scaffoldMember(
      root,
      record({ slug: "critic", name: "Critic", createdAt: "2026-02-01T00:00:00.000Z" }),
    );
    const members = await readMembers(root);
    expect(members.map((m) => m.slug)).toEqual(["critic", "scout"]);
    expect(members[0]?.name).toBe("Critic");
    expect(members[0]?.status).toBe("active");
  });

  test("carries model, provider, and tools through when present", async () => {
    await scaffoldMember(
      root,
      record({ model: "claude-x", provider: "anthropic", tools: ["read"] }),
    );
    const [member] = await readMembers(root);
    expect(member?.model).toBe("claude-x");
    expect(member?.provider).toBe("anthropic");
    expect(member?.tools).toEqual(["read"]);
    expect(member?.role).toBe("Researcher");
  });

  test("a legacy model-only record reads as unpinned (provider-primary coercion)", async () => {
    // Written before the coherence rule: a model with no provider. The read boundary
    // drops the orphan model so no consumer runs it as a stray model on the default.
    await scaffoldMember(root, record({ model: "gpt-5" }));
    const [member] = await readMembers(root);
    expect(member?.model).toBeUndefined();
    expect(member?.provider).toBeUndefined();
  });

  test("an empty / missing data home yields an empty roster", async () => {
    expect(await readMembers(join(root, "nope"))).toEqual([]);
  });

  test("skips a directory without a parseable member.json", async () => {
    await scaffoldMember(root, record());
    await Bun.write(join(root, "junk", "notmember.txt"), "x");
    const members = await readMembers(root);
    expect(members.map((m) => m.slug)).toEqual(["scout"]);
  });

  test("a shape-drifted member.json (valid JSON, bad shape) can't blank the roster", async () => {
    await scaffoldMember(root, record());
    await Bun.write(join(root, "broken", "member.json"), "null");
    await Bun.write(join(root, "nostrings", "member.json"), JSON.stringify({ name: 42 }));
    const members = await readMembers(root);
    expect(members.map((m) => m.slug)).toEqual(["scout"]);
  });

  test("a record with an unknown status reads back as active (the default)", async () => {
    await Bun.write(
      join(root, "ada", "member.json"),
      JSON.stringify({ name: "Ada", charter: "Computes.", createdAt: "2026-03-01T00:00:00.000Z" }),
    );
    await Bun.write(
      join(root, "bo", "member.json"),
      JSON.stringify({
        name: "Bo",
        charter: "Builds.",
        status: "inactive",
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
    );
    const members = await readMembers(root);
    expect(members.find((m) => m.slug === "ada")?.status).toBe("active");
    expect(members.find((m) => m.slug === "bo")?.status).toBe("inactive");
  });

  test("the directory name is the authoritative slug (ignores a drifted json slug)", async () => {
    await Bun.write(
      join(root, "realdir", "member.json"),
      JSON.stringify(record({ slug: "ghost" })),
    );
    const [member] = await readMembers(root);
    expect(member?.slug).toBe("realdir"); // not "ghost" — retire keys off the dir name
  });

  test("a record with a missing or non-string role reads back as an empty role", async () => {
    await Bun.write(
      join(root, "nora", "member.json"),
      JSON.stringify({ name: "Nora", charter: "Notes.", createdAt: "2026-04-02T00:00:00.000Z" }),
    );
    const members = await readMembers(root);
    expect(members.find((m) => m.slug === "nora")?.role).toBe("");
  });

  test("the read-back members build a valid roster board", async () => {
    await scaffoldMember(root, record());
    const board = buildRosterBoard(await readMembers(root));
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });
});

describe("readMember", () => {
  test("returns one member by slug, undefined for an unknown one", async () => {
    await scaffoldMember(root, record());
    expect((await readMember(root, "scout"))?.name).toBe("Scout");
    expect(await readMember(root, "ghost")).toBeUndefined();
  });
});

describe("listMemberRecords", () => {
  test("carries the server-stamped createdAt readMembers drops, newest first", async () => {
    await scaffoldMember(root, record({ createdAt: "2026-01-01T00:00:00.000Z" }));
    await scaffoldMember(
      root,
      record({ slug: "critic", name: "Critic", createdAt: "2026-02-01T00:00:00.000Z" }),
    );
    const records = await listMemberRecords(root);
    expect(records.map((r) => r.slug)).toEqual(["critic", "scout"]);
    expect(records.map((r) => r.createdAt)).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  test("a missing data home yields []", async () => {
    expect(await listMemberRecords(join(root, "nope"))).toEqual([]);
  });
});

describe("readMemberDoc", () => {
  test("returns the authored charter.md, undefined on a miss or unsafe slug", async () => {
    await scaffoldMember(root, record());
    expect(await readMemberDoc(root, "scout", "charter.md")).toContain("Digs up facts.");
    expect(await readMemberDoc(root, "ghost", "charter.md")).toBeUndefined();
    expect(await readMemberDoc(root, "../escape", "charter.md")).toBeUndefined();
  });
});

describe("retireMember", () => {
  test("removes a member and is reflected in the next read", async () => {
    await scaffoldMember(root, record());
    await retireMember(root, "scout");
    expect(await readMembers(root)).toEqual([]);
  });

  test("errors on an unknown slug and rejects an unsafe one", async () => {
    await expect(retireMember(root, "ghost")).rejects.toThrow(/not found/);
    await expect(retireMember(root, "../escape")).rejects.toThrow();
  });
});

describe("setMemberModel", () => {
  test("sets model and provider on an existing member", async () => {
    await scaffoldMember(root, record());
    await setMemberModel(root, "scout", { model: " claude-opus-4.8 ", provider: " anthropic " });
    const [member] = await readMembers(root);
    expect(member?.model).toBe("claude-opus-4.8");
    expect(member?.provider).toBe("anthropic");
  });

  test("rejects a model pinned without its provider", async () => {
    await scaffoldMember(root, record());
    await expect(setMemberModel(root, "scout", { model: "gpt-5.3-codex" })).rejects.toThrow(
      /needs its provider/,
    );
  });

  test("blank model clears both model and provider", async () => {
    await scaffoldMember(root, record({ model: "claude-opus-4.8", provider: "anthropic" }));
    await setMemberModel(root, "scout", { model: " " });
    const [member] = await readMembers(root);
    expect(member?.model).toBeUndefined();
    expect(member?.provider).toBeUndefined();
  });

  test("sets provider alone — a vendor pin with the provider's default model", async () => {
    await scaffoldMember(root, record({ model: "old", provider: "anthropic" }));
    await setMemberModel(root, "scout", { provider: "copilot" });
    const [member] = await readMembers(root);
    expect(member?.provider).toBe("copilot");
    expect(member?.model).toBeUndefined();
  });

  test("throws on unknown and unsafe slugs", async () => {
    await expect(setMemberModel(root, "ghost", { model: "x" })).rejects.toThrow(/not found/);
    await expect(setMemberModel(root, "../escape", { model: "x" })).rejects.toThrow();
  });

  test("preserves other member record fields", async () => {
    await scaffoldMember(root, record({ tools: ["read"] }));
    await setMemberModel(root, "scout", { model: "claude-opus-4.8", provider: "anthropic" });
    const rec = JSON.parse(await readFile(join(root, "scout", "member.json"), "utf8"));
    expect(rec.name).toBe("Scout");
    expect(rec.role).toBe("Researcher");
    expect(rec.status).toBe("active");
    expect(rec.tools).toEqual(["read"]);
  });
});

describe("writeMemory", () => {
  test("overwrites memory.md in place with the consolidated text", async () => {
    await scaffoldMember(root, record());
    await writeMemory(root, "scout", "# Memory\n\nThe operator prefers terse answers.");
    const memory = await readMemberDoc(root, "scout", "memory.md");
    expect(memory).toContain("The operator prefers terse answers.");
    // A second write replaces rather than appends — the store never merges.
    await writeMemory(root, "scout", "Only this now.");
    const after = (await readMemberDoc(root, "scout", "memory.md")) ?? "";
    expect(after).toContain("Only this now.");
    expect(after).not.toContain("terse answers");
  });

  test("rejects over-cap text and leaves the prior memory intact (fail closed)", async () => {
    await scaffoldMember(root, record());
    await writeMemory(root, "scout", "kept");
    await expect(writeMemory(root, "scout", "x".repeat(MEMORY_DOC_CAP + 1))).rejects.toThrow(
      /exceeds/,
    );
    expect(await readMemberDoc(root, "scout", "memory.md")).toContain("kept");
  });

  test("fails closed on a missing member and an unsafe slug", async () => {
    await expect(writeMemory(root, "ghost", "x")).rejects.toThrow(/not found/);
    await expect(writeMemory(root, "../escape", "x")).rejects.toThrow();
  });
});

describe("appendLog", () => {
  test("appends a timestamped, single-line entry under the header", async () => {
    await scaffoldMember(root, record());
    await appendLog(root, "scout", "reviewed the\nrelease  plan", "2026-06-26T00:00:00.000Z");
    const log = await readMemberDoc(root, "scout", "log.md");
    expect(log).toContain("# Log");
    expect(log).toContain("- 2026-06-26T00:00:00.000Z — reviewed the release plan");
    expect(log).toContain("genesis"); // the genesis line is still present
  });

  test("bounds the journal to the most recent LOG_MAX_ENTRIES entries", async () => {
    await scaffoldMember(root, record());
    for (let i = 0; i < LOG_MAX_ENTRIES + 10; i++) {
      await appendLog(root, "scout", `entry ${i}`, "2026-06-26T00:00:00.000Z");
    }
    const log = (await readMemberDoc(root, "scout", "log.md")) ?? "";
    const bullets = log.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(LOG_MAX_ENTRIES);
    expect(log).toContain(`entry ${LOG_MAX_ENTRIES + 9}`);
    expect(log).not.toContain("genesis"); // the oldest aged out
  });

  test("caps a runaway entry at LOG_ENTRY_CAP characters", async () => {
    await scaffoldMember(root, record());
    await appendLog(root, "scout", "x".repeat(LOG_ENTRY_CAP * 2), "2026-06-26T00:00:00.000Z");
    const log = (await readMemberDoc(root, "scout", "log.md")) ?? "";
    const entry = log.split("\n").find((l) => l.includes("xxxx")) ?? "";
    expect(entry.length).toBe(LOG_ENTRY_CAP);
  });

  test("fails closed on a missing member and an unsafe slug", async () => {
    await expect(appendLog(root, "ghost", "x", "t")).rejects.toThrow(/not found/);
    await expect(appendLog(root, "../escape", "x", "t")).rejects.toThrow();
  });
});

describe("scaffoldRoster (batch)", () => {
  const rec = (slug: string, over: Partial<MemberRecord> = {}): MemberRecord => ({
    slug,
    name: slug,
    role: "Engineer",
    charter: `# ${slug}`,
    status: "active",
    createdAt: "2026-06-27T00:00:00.000Z",
    ...over,
  });

  test("scaffolds every member and persists capability tags", async () => {
    const result = await scaffoldRoster(root, [
      rec("atlas", { tools: ["code", "read"] }),
      rec("vera"),
    ]);
    expect(result.created.sort()).toEqual(["atlas", "vera"]);
    expect(result.skipped).toEqual([]);
    expect((await readMember(root, "atlas"))?.tools).toEqual(["code", "read"]);
    // No tags -> a text-only member (tools omitted).
    expect((await readMember(root, "vera"))?.tools).toBeUndefined();
  });

  test("is collision-safe — an existing member is skipped, never clobbered", async () => {
    await scaffoldMember(root, rec("atlas", { charter: "# Atlas (authored)" }));
    const result = await scaffoldRoster(root, [
      rec("atlas", { charter: "# Atlas (cast)" }),
      rec("vera"),
    ]);
    expect(result.created).toEqual(["vera"]);
    expect(result.skipped).toEqual(["atlas"]);
    // The authored charter stands.
    expect(await readMemberDoc(root, "atlas", "charter.md")).toContain("authored");
  });

  test("caps the batch at maxMembers and reports the truncation count", async () => {
    const records = ["a", "b", "c", "d"].map((s) => rec(s));
    const result = await scaffoldRoster(root, records, { maxMembers: 2 });
    expect(result.created).toEqual(["a", "b"]);
    expect(result.truncated).toBe(2);
    expect(await readMember(root, "c")).toBeUndefined();
  });
});

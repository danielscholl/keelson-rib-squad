import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext } from "@keelson/shared";
import rib from "../src/index.ts";
import { readMember, scaffoldMember } from "../src/member-store.ts";
import { scopeMembersDir, setSquadDataHome } from "../src/paths.ts";
import { writeSelectedProject } from "../src/scope.ts";

let home: string;
let refreshed: string[];

type Providers = { id: string; displayName: string }[];

// Boot with a getProviders that can be absent, present, or THROWING — the three states
// the roster's pin validation has to tell apart.
function bootRib(getProviders?: () => Providers): void {
  refreshed = [];
  const ctx = {
    getDataDir: () => home,
    getProjects: () => [{ id: "p1", name: "keelson", rootPath: "/repo/keelson", createdAt: "x" }],
    refreshWorkflow: async (name: string) => {
      refreshed.push(name);
    },
    ...(getProviders ? { getProviders } : {}),
  } as unknown as RibContext;
  rib.registerTools?.(ctx);
}

async function seatMember(over: { model?: string; provider?: string } = {}): Promise<void> {
  await writeSelectedProject(home, {
    scopeId: "p1",
    projectId: "p1",
    name: "keelson",
    rootPath: "/repo/keelson",
    at: "2026-06-30T00:00:00.000Z",
  });
  await scaffoldMember(scopeMembersDir(home, "p1"), {
    slug: "atlas",
    name: "Atlas",
    role: "Engineer",
    charter: "# Atlas",
    status: "active",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...over,
  });
}

const setModel = (payload: Record<string, unknown>) =>
  rib.onAction?.({ type: "set-model", payload }, {} as RibContext);

const pinOf = async () => {
  const m = await readMember(scopeMembersDir(home, "p1"), "atlas");
  return { model: m?.model, provider: m?.provider };
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "squad-set-model-"));
});

afterEach(async () => {
  rib.dispose?.();
  setSquadDataHome(undefined);
  await rm(home, { recursive: true, force: true });
});

describe("set-model action", () => {
  test("a catalog pick persists the model with its provider and refreshes the roster", async () => {
    bootRib(() => [{ id: "openai", displayName: "OpenAI" }]);
    await seatMember();
    const res = await setModel({ slug: "atlas", model: "gpt-5.5", provider: "openai" });
    expect(res?.ok).toBe(true);
    expect(await pinOf()).toEqual({ model: "gpt-5.5", provider: "openai" });
    expect(refreshed).toEqual(["squad-roster"]);
  });

  test("the picker's clear row removes both keys rather than leaving half a pin", async () => {
    bootRib(() => [{ id: "openai", displayName: "OpenAI" }]);
    await seatMember({ model: "gpt-5.5", provider: "openai" });
    // ModelFieldPicker's clear dispatches pick("", ""), which reaches us as empty strings.
    const res = await setModel({ slug: "atlas", model: "", provider: "" });
    expect(res?.ok).toBe(true);
    expect(await pinOf()).toEqual({ model: undefined, provider: undefined });
  });

  test("a model with no provider is rejected, not written as half a pin", async () => {
    bootRib(() => [{ id: "openai", displayName: "OpenAI" }]);
    await seatMember();
    const res = await setModel({ slug: "atlas", model: "gpt-5.5" });
    expect(res?.ok).toBe(false);
    expect(res?.ok === false && res.error).toContain("a pinned model needs its provider");
    expect(await pinOf()).toEqual({ model: undefined, provider: undefined });
  });

  test("an unregistered provider fails closed rather than silently falling back at turn time", async () => {
    bootRib(() => [{ id: "openai", displayName: "OpenAI" }]);
    await seatMember();
    const res = await setModel({ slug: "atlas", model: "x", provider: "typo" });
    expect(res?.ok).toBe(false);
    expect(res?.ok === false && res.error).toContain("not registered");
    expect(await pinOf()).toEqual({ model: undefined, provider: undefined });
  });

  test("a throwing provider seam rejects a pin it cannot vouch for", async () => {
    bootRib(() => {
      throw new Error("catalog exploded");
    });
    await seatMember();
    const res = await setModel({ slug: "atlas", model: "gpt-5.5", provider: "openai" });
    expect(res?.ok).toBe(false);
    // A controlled validation outcome, not a raw exception string.
    expect(res?.ok === false && res.error).toContain("not registered");
    expect(res?.ok === false && res.error).not.toContain("catalog exploded");
    expect(await pinOf()).toEqual({ model: undefined, provider: undefined });
  });

  test("a throwing provider seam still lets a pin be CLEARED — the clear reads no catalog", async () => {
    bootRib(() => {
      throw new Error("catalog exploded");
    });
    await seatMember({ model: "gpt-5.5", provider: "openai" });
    const res = await setModel({ slug: "atlas", model: "", provider: "" });
    expect(res?.ok).toBe(true);
    expect(await pinOf()).toEqual({ model: undefined, provider: undefined });
  });

  test("no provider seam at all admits the pin — an older harness has no catalog to check", async () => {
    bootRib();
    await seatMember();
    const res = await setModel({ slug: "atlas", model: "gpt-5.5", provider: "openai" });
    expect(res?.ok).toBe(true);
    expect(await pinOf()).toEqual({ model: "gpt-5.5", provider: "openai" });
  });

  test("an unknown slug fails closed rather than throwing out of the store", async () => {
    bootRib(() => [{ id: "openai", displayName: "OpenAI" }]);
    await seatMember();
    const res = await setModel({ slug: "ghost", model: "gpt-5.5", provider: "openai" });
    expect(res?.ok).toBe(false);
    expect(res?.ok === false && res.error).toContain("no member 'ghost'");
  });
});

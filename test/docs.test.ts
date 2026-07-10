import { describe, expect, test } from "bun:test";
import { ribDocsSourceSchema } from "@keelson/shared";
import rib from "../src/index.ts";

describe("contributed docs", () => {
  test("the rib contributes one valid docs source pointing at its published corpus", () => {
    const ctx = {} as Parameters<NonNullable<typeof rib.contributeDocs>>[0];
    const sources = rib.contributeDocs?.(ctx) ?? [];
    expect(sources).toHaveLength(1);
    const source = sources[0];
    expect(ribDocsSourceSchema.safeParse(source).success).toBe(true);
    expect(source?.llmsFullUrl).toBe(
      "https://danielscholl.github.io/keelson-rib-squad/llms-full.txt",
    );
  });
});

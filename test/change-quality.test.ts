import { describe, expect, test } from "bun:test";
import {
  type ChangeQualityDiffNumstat,
  detectChangeQualityViolations,
} from "../src/change-quality.ts";

interface Case {
  name: string;
  diffNumstat: ChangeQualityDiffNumstat;
  addedLines: readonly string[];
  expectedCodes: readonly string[];
}

const cases: readonly Case[] = [
  {
    name: "flags a diff that net-removes a test file",
    diffNumstat: {
      files: [{ path: "test/dispatch.test.ts", added: 0, removed: 42 }],
    },
    addedLines: [],
    expectedCodes: ["net-test-file-removal"],
  },
  {
    name: "flags net-removal of test()/it()/expect() occurrences from numstat-derived token counts",
    diffNumstat: {
      files: [{ path: "src/dispatch.ts", added: 10, removed: 9 }],
      tokenNet: { testCall: -1, itCall: 0, expectCall: -3 },
    },
    addedLines: [],
    expectedCodes: ["net-test-call-removal"],
  },
  {
    name: "flags renaming a test file to a non-test path",
    diffNumstat: {
      files: [{ path: "src/dispatch.ts", added: 0, removed: 0 }],
      nameStatus: [{ status: "R", previousPath: "test/dispatch.test.ts", path: "src/dispatch.ts" }],
      tokenNet: { testCall: 0, itCall: 0, expectCall: 0 },
    },
    addedLines: [],
    expectedCodes: ["net-test-file-removal"],
  },
  {
    name: "does not flag pure test-to-test rename with preserved token net",
    diffNumstat: {
      files: [{ path: "test/new-dispatch.test.ts", added: 0, removed: 0 }],
      nameStatus: [
        { status: "R", previousPath: "test/dispatch.test.ts", path: "test/new-dispatch.test.ts" },
      ],
      tokenNet: { testCall: 0, itCall: 0, expectCall: 0 },
    },
    addedLines: [],
    expectedCodes: [],
  },
  {
    name: "does not flag the existing moved-test refactor (equal add/remove, net zero)",
    diffNumstat: {
      files: [{ path: "test/coordinator.test.ts", added: 20, removed: 20 }],
      tokenNet: { testCall: 0, itCall: 0, expectCall: 0 },
    },
    addedLines: [],
    expectedCodes: [],
  },
  {
    name: "flags suppression comments added in new lines",
    diffNumstat: {
      files: [{ path: "src/coordinator.ts", added: 4, removed: 0 }],
    },
    addedLines: [
      "// @ts-ignore TODO",
      "// @ts-expect-error temporary",
      "// biome-ignore lint/suspicious/noExplicitAny: intentional",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
    ],
    expectedCodes: ["added-suppression-comment"],
  },
  {
    name: "does not flag suppression text that exists only in removed or context lines",
    diffNumstat: {
      files: [{ path: "src/coordinator.ts", added: 1, removed: 3 }],
    },
    addedLines: ["const ok = true;"],
    expectedCodes: [],
  },
  {
    name: "returns no violations for a clean diff",
    diffNumstat: {
      files: [{ path: "src/coordinator.ts", added: 12, removed: 2 }],
      tokenNet: { testCall: 1, itCall: 0, expectCall: 2 },
    },
    addedLines: ["const ready = true;", 'return { action: "done" } as const;'],
    expectedCodes: [],
  },
];

describe("detectChangeQualityViolations", () => {
  for (const c of cases) {
    test(c.name, () => {
      const violations = detectChangeQualityViolations(c.diffNumstat, c.addedLines);
      expect(violations.map((v) => v.code)).toEqual([...c.expectedCodes]);
    });
  }
});

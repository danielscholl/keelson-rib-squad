export interface DiffNumstatEntry {
  path: string;
  added: number;
  removed: number;
}

export interface DiffNameStatusEntry {
  status: string;
  path: string;
  previousPath?: string;
}

export interface DiffTokenNetCounts {
  testCall: number;
  itCall: number;
  expectCall: number;
}

export interface ChangeQualityDiffNumstat {
  files: readonly DiffNumstatEntry[];
  tokenNet?: DiffTokenNetCounts;
  nameStatus?: readonly DiffNameStatusEntry[];
}

export interface ChangeQualityViolation {
  code: string;
  message: string;
}

const SUPPRESSION_LINE = /(?:biome-ignore|@ts-ignore|@ts-expect-error|eslint-disable)/;
const TEST_FILE_PATH = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;

export function detectChangeQualityViolations(
  diffNumstat: ChangeQualityDiffNumstat,
  addedLines: readonly string[],
): readonly ChangeQualityViolation[] {
  const out: ChangeQualityViolation[] = [];

  const removedTestFile =
    diffNumstat.files.some((f) => TEST_FILE_PATH.test(f.path) && f.removed > f.added) ||
    (diffNumstat.nameStatus ?? []).some(
      (entry) =>
        entry.status === "R" &&
        typeof entry.previousPath === "string" &&
        TEST_FILE_PATH.test(entry.previousPath) &&
        !TEST_FILE_PATH.test(entry.path),
    );
  if (removedTestFile) {
    out.push({
      code: "net-test-file-removal",
      message: "diff net-removes at least one test file",
    });
  }

  const tokenNet = diffNumstat.tokenNet;
  if (tokenNet && (tokenNet.testCall < 0 || tokenNet.itCall < 0 || tokenNet.expectCall < 0)) {
    out.push({
      code: "net-test-call-removal",
      message: "diff net-removes test()/it()/expect() occurrences",
    });
  }

  const addedSuppression = addedLines.some((line) => SUPPRESSION_LINE.test(line));
  if (addedSuppression) {
    out.push({
      code: "added-suppression-comment",
      message: "diff adds suppression comments on new lines",
    });
  }

  return out;
}

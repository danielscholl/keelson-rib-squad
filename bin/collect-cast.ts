#!/usr/bin/env bun
import { buildCastBoard } from "../src/boards/cast.ts";
/**
 * Cast collector — the producer behind the `squad-cast` workflow. Reads the pending
 * cast proposal (cast-proposal.json) under the data home and prints a canvas
 * board-view JSON object (the Proposed-squad board: one card per proposed member
 * plus Approve/Discard), and nothing else, to stdout. Degrades to the calm idle
 * board: a missing/unreadable/invalid proposal yields the "no proposal" board,
 * never a throw.
 */
import { readProposal } from "../src/cast.ts";
import { squadDataHome } from "../src/paths.ts";

async function main() {
  // The squad-cast bash node bakes the resolved data home in as argv[2] (the same
  // path the in-process rib captured), so this out-of-process collector reads the
  // proposal from it without resolving the home itself. Fall back to squadDataHome()
  // for a manual/standalone run.
  const home = process.argv[2]?.trim() || squadDataHome();
  const proposal = await readProposal(home).catch(() => undefined);
  process.stdout.write(JSON.stringify(buildCastBoard(proposal)));
}

await main();

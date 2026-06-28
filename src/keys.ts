// The id of the Squad surface and the roster snapshot key. Shared between the
// surface/view declarations and the workflow binding in index.ts so the
// registerRegion target and the bound producer can't drift from each other.
export const SQUAD_SURFACE_ID = "squad";
export const ROSTER_KEY = "rib:squad:roster";
// The governed shared-decision ledger panel. Bound to the squad-decisions
// workflow (a `memory: { recall }` block feeding a board) and rendered on the
// Squad surface; decisions are written by squad-decide (a `memory: { writeback }`).
export const DECISIONS_KEY = "rib:squad:decisions";
// The auto-cast proposal panel. Bound to the squad-cast collector (it renders the
// pending cast-proposal.json) and rendered on the Squad surface; the proposal is
// produced by the cast-propose board action (a confined repo-scan turn) and consumed
// by approve-cast (scaffold) / discard-cast (clear).
export const CAST_KEY = "rib:squad:cast";
// The coordinator run-loop panel. Bound to the squad-coordinator collector (it renders the
// persisted coordinator-ledger.json) and rendered on the Squad surface; the ledger is produced
// by the squad_coordinate tool's Magentic loop, refreshed when a run completes.
export const COORDINATOR_KEY = "rib:squad:coordinator";

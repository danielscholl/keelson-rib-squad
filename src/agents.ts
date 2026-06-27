import { buildSeedFor } from "./compose.ts";
import { readMembers } from "./member-store.ts";
import { membersDir } from "./paths.ts";

// The rib's agents for the harness GET /api/agents: each member, with its charter
// (clamped) as the description. Cheap — no system prompt composed here.
export async function listAgents(): Promise<{ slug: string; name: string; description: string }[]> {
  // Clamp to the shared agentSummary caps (name 80, description 280): the host
  // DROPS a whole summary that fails validation, so an over-long member would
  // silently vanish from /api/agents while still being enterable from the roster.
  return (await readMembers(membersDir())).map((m) => ({
    slug: m.slug,
    name: m.name.slice(0, 80),
    description: m.charter.slice(0, 280),
  }));
}

// Resolve one member to a chat seed — the SAME seed the roster Enter action builds
// (buildSeedFor), so the two entry points can't drift. Carries the member's
// model/provider when set. Null for an unknown slug.
export async function resolveAgent(slug: string): Promise<{
  systemPrompt: string;
  name: string;
  openingPrompt: string;
  model?: string;
  providerId?: string;
} | null> {
  const member = (await readMembers(membersDir())).find((m) => m.slug === slug);
  if (!member) return null;
  return buildSeedFor(membersDir(), member);
}

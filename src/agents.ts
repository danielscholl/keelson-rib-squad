import { buildSeedFor } from "./compose.ts";
import { readMembers } from "./member-store.ts";
import { squadDataHome } from "./paths.ts";
import { listScopeMembersDirs } from "./scope.ts";

// The rib's agents for the harness GET /api/agents: each member across every scope
// (the default tree + each per-project team), with its charter (clamped) as the
// description. Cheap — no system prompt composed here. Deduped by slug, first
// occurrence wins in scope precedence (default scope first, then sorted project
// order), so two scopes casting an "atlas" surface ONE card, not a confusing pair.
export async function listAgents(): Promise<{ slug: string; name: string; description: string }[]> {
  const dirs = await listScopeMembersDirs(squadDataHome());
  const seen = new Set<string>();
  const agents: { slug: string; name: string; description: string }[] = [];
  for (const dir of dirs) {
    for (const m of await readMembers(dir)) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      // Clamp to the shared agentSummary caps (name 80, description 280): the host
      // DROPS a whole summary that fails validation, so an over-long member would
      // silently vanish from /api/agents while still being enterable from the roster.
      agents.push({
        slug: m.slug,
        name: m.name.slice(0, 80),
        description: m.charter.slice(0, 280),
      });
    }
  }
  return agents;
}

// Resolve one member to a chat seed — the SAME seed the roster Enter action builds
// (buildSeedFor), so the two entry points can't drift. First match across the scope
// member dirs in precedence order (default scope first, then sorted project order),
// seeded from the dir it was found in. Carries the member's model/provider when set.
// Null for an unknown slug.
export async function resolveAgent(slug: string): Promise<{
  systemPrompt: string;
  name: string;
  openingPrompt: string;
  model?: string;
  providerId?: string;
} | null> {
  for (const dir of await listScopeMembersDirs(squadDataHome())) {
    const member = (await readMembers(dir)).find((m) => m.slug === slug);
    if (member) return buildSeedFor(dir, member);
  }
  return null;
}

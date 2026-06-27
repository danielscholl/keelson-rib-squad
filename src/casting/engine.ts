// The pure, deterministic casting engine: pick a squad's ensemble and assign a
// character to a role. No I/O, no provider, no Math.random — same registry state
// in, same casting out. registry.ts feeds it a ThemeUsage snapshot and persists the
// reservations; this file only decides.

import { canonicalRole, THEMES, type Theme, type ThemeCharacter, themeById } from "./themes.ts";

// The slice of registry state theme selection needs: the squad's active ensemble,
// the order ensembles were activated (for LRU), and how many active members each
// already holds (for capacity).
export interface ThemeUsage {
  activeThemeId?: string;
  themeHistory: readonly string[];
  activeCountByTheme: Readonly<Record<string, number>>;
}

function capacityLeft(theme: Theme, usage: ThemeUsage): number {
  return theme.characters.length - (usage.activeCountByTheme[theme.id] ?? 0);
}

function hasCapacity(theme: Theme, usage: ThemeUsage): boolean {
  return capacityLeft(theme, usage) > 0;
}

// Catalog order by least-recently-used: a never-activated ensemble (not in history)
// sorts ahead of any activated one (so a fresh squad walks the catalog in order),
// then by recency ascending. Array.sort is stable, so ties keep catalog order —
// the whole ordering is deterministic.
function lruOrder(history: readonly string[]): Theme[] {
  const lastUse = (id: string): number => history.lastIndexOf(id);
  return [...THEMES].sort((a, b) => lastUse(a.id) - lastUse(b.id));
}

// The order ensembles are tried in: the active one first while it still has
// capacity (one squad, one cast), else LRU/catalog order. assignThemedIdentity
// walks this list, rolling to the next ensemble when one is exhausted.
export function themeSelectionOrder(usage: ThemeUsage): Theme[] {
  const active = usage.activeThemeId ? themeById(usage.activeThemeId) : undefined;
  const lru = lruOrder(usage.themeHistory);
  if (active && hasCapacity(active, usage)) {
    return [active, ...lru.filter((t) => t.id !== active.id)];
  }
  return lru;
}

// The squad's ensemble: reuse the active one while it has capacity, else the next
// by the deterministic LRU/catalog rule. Never random.
export function selectTheme(usage: ThemeUsage): Theme {
  return themeSelectionOrder(usage)[0] ?? THEMES[0]!;
}

// Best-fit assignment within one ensemble: a free character whose PRIMARY preferred
// role matches → any free character that LISTS the role → any free character.
// Case/fuzzy tolerant on the wanted role (canonicalRole). undefined only when every
// character in the ensemble is taken — the caller then rolls to the next ensemble.
export function assignCharacter(
  role: string,
  theme: Theme,
  takenNames: ReadonlySet<string>,
): ThemeCharacter | undefined {
  const want = canonicalRole(role);
  const free = (c: ThemeCharacter): boolean => !takenNames.has(c.name);
  return (
    theme.characters.find((c) => free(c) && c.preferredRoles[0] === want) ??
    theme.characters.find((c) => free(c) && c.preferredRoles.includes(want)) ??
    theme.characters.find(free)
  );
}

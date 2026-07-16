import { capacityLeft, type ThemeUsage } from "./engine.ts";
import {
  activeNames,
  type CastingRegistry,
  CUSTOM_THEME_CAPACITY,
  type ThemingConfig,
  usageOf,
} from "./registry.ts";
import { THEMES, themeById } from "./themes.ts";

// The read-only casting context an LLM turn needs to make an informed cast
// decision: what the squad's ensemble is doing today, what it can pick from
// (the static catalog, as inspiration, plus any custom ensemble it has already
// invented), what names are already taken, and any operator pin to respect. Pure
// — built from an already-loaded registry, no I/O of its own.
export interface CastingOptionsView {
  mode: "themed" | "off";
  pin?: string;
  activeTheme?: { id: string; label: string; remainingCapacity: number };
  themeHistory: string[];
  catalog: { id: string; label: string; characterNames: string[] }[];
  customThemes: {
    id: string;
    label: string;
    characterNames: string[];
    remainingCapacity: number;
  }[];
  takenCharacterNames: string[];
}

export function castingOptions(reg: CastingRegistry, config: ThemingConfig): CastingOptionsView {
  if (config.mode === "off") {
    return {
      mode: "off",
      themeHistory: [],
      catalog: [],
      customThemes: [],
      takenCharacterNames: [],
    };
  }

  const usage = usageOf(reg);

  const activeTheme = usage.activeThemeId ? resolveActiveTheme(reg, usage) : undefined;

  // A catalog ensemble this squad has grown stays ONE entry, listed with the catalog and
  // carrying the characters the squad added. Splitting it across both lists would read as
  // two rival ensembles of the same name, and the custom entry's short roster would look
  // like the whole work.
  const customThemes = Object.entries(reg.customThemes ?? {})
    .filter(([id]) => !themeById(id))
    .map(([id, t]) => ({
      id,
      label: t.label,
      characterNames: t.characters.map((c) => c.name),
      remainingCapacity: remainingCustomCapacity(usage.activeCountByTheme, id),
    }));

  return {
    mode: "themed",
    ...(config.pin ? { pin: config.pin } : {}),
    ...(activeTheme ? { activeTheme } : {}),
    themeHistory: [...usage.themeHistory],
    catalog: THEMES.map((t) => ({
      id: t.id,
      label: t.label,
      characterNames: [...t.characters, ...grownCharacters(reg, t.id)].map((c) => c.name),
    })),
    customThemes,
    takenCharacterNames: [...activeNames(reg)].sort(),
  };
}

function resolveActiveTheme(
  reg: CastingRegistry,
  usage: ThemeUsage,
): { id: string; label: string; remainingCapacity: number } | undefined {
  const id = usage.activeThemeId;
  if (!id) return undefined;
  const staticTheme = themeById(id);
  if (staticTheme) {
    // Count the characters the squad added, not just the catalog's examples: reporting a
    // grown ensemble as full would tell the prompt to roll to a new one and scatter a
    // squad that still has room. capacityLeft is the engine's view, which is narrower on
    // purpose — it can only assign the catalog's own characters.
    return {
      id: staticTheme.id,
      label: staticTheme.label,
      remainingCapacity: Math.max(
        0,
        capacityLeft(staticTheme, usage) + grownCharacters(reg, id).length,
      ),
    };
  }
  const custom = reg.customThemes?.[id];
  if (!custom) return undefined;
  return {
    id,
    label: custom.label,
    remainingCapacity: remainingCustomCapacity(usage.activeCountByTheme, id),
  };
}

// The characters a squad has cast into a CATALOG ensemble beyond the ones it ships with
// — the model may name any character from a real work, so a catalog roster grows like an
// invented one. Casting a LISTED character mints it too (canon carries the squad's own
// voice for it), so those are filtered out here: counting a character under both its
// catalog entry and its minted one would list it twice and overstate the room left.
function grownCharacters(reg: CastingRegistry, themeId: string): readonly { name: string }[] {
  const listed = new Set(themeById(themeId)?.characters.map((c) => c.name) ?? []);
  return (reg.customThemes?.[themeId]?.characters ?? []).filter((c) => !listed.has(c.name));
}

function remainingCustomCapacity(
  activeCountByTheme: Readonly<Record<string, number>>,
  id: string,
): number {
  return Math.max(0, CUSTOM_THEME_CAPACITY - (activeCountByTheme[id] ?? 0));
}

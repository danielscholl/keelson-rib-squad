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

  const customThemes = Object.entries(reg.customThemes ?? {}).map(([id, t]) => ({
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
      characterNames: t.characters.map((c) => c.name),
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
    return {
      id: staticTheme.id,
      label: staticTheme.label,
      remainingCapacity: capacityLeft(staticTheme, usage),
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

function remainingCustomCapacity(
  activeCountByTheme: Readonly<Record<string, number>>,
  id: string,
): number {
  return Math.max(0, CUSTOM_THEME_CAPACITY - (activeCountByTheme[id] ?? 0));
}

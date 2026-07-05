// The Squad domain model. Rib-internal types — only canvas boards cross the wire,
// so these stay plain TS (no Zod). None exist in @keelson/shared.

import type { CanvasTone } from "@keelson/shared";

export type MemberSlug = string;

export type MemberStatus = "active" | "inactive";

export const IDENTITY_SLOT_COUNT = 5;

// The host's reserved identity tones, in slot order. A member keeps one hue for
// life (assigned at cast, persisted on the record); anything without a valid
// slot folds to neutral + name — never a hash, never a status hue.
export const IDENTITY_SLOT_TONES: readonly CanvasTone[] = [
  "id-blue",
  "id-amber",
  "id-teal",
  "id-rose",
  "id-olive",
];

export function identityToneForSlot(slot: number | undefined): CanvasTone {
  return typeof slot === "number" &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < IDENTITY_SLOT_COUNT
    ? IDENTITY_SLOT_TONES[slot]!
    : "neutral";
}

// Speaker-label → identity tone for the run boards, keyed by slug and by
// lowercased display name (ledger entries carry either).
export function identityTonesByMember(members: readonly Member[]): Map<string, CanvasTone> {
  const map = new Map<string, CanvasTone>();
  for (const m of members) {
    const tone = identityToneForSlot(m.identitySlot);
    map.set(m.slug.toLowerCase(), tone);
    const name = m.name.trim().toLowerCase();
    if (name) map.set(name, tone);
  }
  return map;
}

export function identitySlotForIndex(index: number): number {
  const slot = Math.trunc(index);
  if (!Number.isFinite(slot)) return 0;
  return Math.min(Math.max(0, slot), IDENTITY_SLOT_COUNT - 1);
}

export function normalizeIdentitySlot(value: unknown, fallbackIndex = 0): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < IDENTITY_SLOT_COUNT
    ? value
    : identitySlotForIndex(fallbackIndex);
}

export function normalizeToolAllowlist(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = [
    ...new Set(value.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)),
  ];
  return tools.length > 0 ? tools : undefined;
}

export interface Member {
  slug: MemberSlug;
  name: string;
  // The member's role, carried into the roster card's pill. `readMembers` supplies
  // an empty fallback for a drifted record so the board can render a placeholder.
  role: string;
  // The identity text (the body of charter.md) — who this member is, what it is
  // for, how it works. The chat composer reads it to seed a direct conversation.
  charter: string;
  status: MemberStatus;
  model?: string;
  // The provider that serves `model`. Pin it alongside `model` so entering the
  // member sends a coherent provider/model pair; omitted keeps the surface's
  // current provider.
  provider?: string;
  // Free-form capability slugs (unconstrained in Phase 0). Omitting yields a
  // text-only chat agent.
  tools?: readonly string[];
  toolAllowlist?: readonly string[];
  // Themed-casting identity (#16). Set when the member was cast from an ensemble:
  // themeId is the ensemble it belongs to, personality/backstory its character's
  // voice (also folded into the charter), and originalName the proposed name casting
  // replaced. All optional/back-compat — a pre-casting or opted-out member has none.
  themeId?: string;
  personality?: string;
  backstory?: string;
  originalName?: string;
  identitySlot?: number;
}

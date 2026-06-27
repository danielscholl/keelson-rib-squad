// The Squad domain model. Rib-internal types — only canvas boards cross the wire,
// so these stay plain TS (no Zod). None exist in @keelson/shared.

export type MemberSlug = string;

export type MemberStatus = "active" | "inactive";

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
}

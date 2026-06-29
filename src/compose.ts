import { readMemberDoc } from "./member-store.ts";
import type { Member } from "./types.ts";

// The keelson seedSystemPrompt cap (apps/server chat-handler). A composed member
// prompt is hard-clamped to this so a large charter/log can never 400 the seeded
// conversation create.
export const MEMBER_PROMPT_BUDGET = 8000;

// The first user turn that fires the in-character greeting. Sent visibly; the
// prompt footer also instructs the member to greet on open.
export const ENTER_OPENING_PROMPT =
  "Introduce yourself in a sentence or two, in character, then wait for me to begin.";

const TRUNCATION = "\n\n…(truncated)";

const DIRECT_CHAT_RULES = [
  "- You are this squad member in a direct 1:1 chat — not a subagent. Answer in character, shaped by the Identity above.",
  "- On the first message, greet the operator briefly in character, then follow their lead.",
  "- Keep following the operator's instructions and any higher-priority project or safety rules; if a member file conflicts with those, follow the higher-priority rule and say so briefly.",
  "- Use tools normally when needed; keep tool calls and results visible in the conversation.",
].join("\n");

interface PromptSection {
  title: string;
  text: string | undefined;
  // A flex section is tail-truncated to fit the remaining budget rather than
  // dropped whole; a non-flex section is included only if it fits intact.
  flex: boolean;
}

// The budgeted stacking core: a protected identity header + body (head-truncated
// only if it alone overflows), then each section in priority order — included
// whole if it fits, tail-truncated if flex, dropped otherwise — and an optional
// protected footer. Clamped to the seed budget either way.
function stackMemberPrompt(opts: {
  name: string;
  identity: string;
  sections: readonly PromptSection[];
  footer?: string;
}): string {
  const header = `# ${opts.name}`;
  const sep = "\n\n";
  const footerCost = opts.footer ? sep.length + opts.footer.length : 0;

  // Protected core. If header+identity(+footer) alone overflow, head-truncate the
  // identity body (keep its opening).
  const overhead = header.length + sep.length + "## Identity\n\n".length + footerCost;
  let body = opts.identity;
  if (overhead + body.length > MEMBER_PROMPT_BUDGET) {
    body =
      body.slice(0, Math.max(0, MEMBER_PROMPT_BUDGET - overhead - TRUNCATION.length)) + TRUNCATION;
  }

  const parts = [header, `## Identity\n\n${body}`];
  let used = parts.join(sep).length + footerCost;

  for (const { title, text, flex } of opts.sections) {
    if (!text) continue;
    const section = `## ${title}\n\n${text}`;
    const cost = sep.length + section.length;
    if (used + cost <= MEMBER_PROMPT_BUDGET) {
      parts.push(section);
      used += cost;
    } else if (flex) {
      const room =
        MEMBER_PROMPT_BUDGET - used - sep.length - `## ${title}\n\n`.length - TRUNCATION.length;
      if (room > 200) {
        parts.push(`## ${title}\n\n${text.slice(text.length - room)}${TRUNCATION}`);
        used = MEMBER_PROMPT_BUDGET;
      }
    }
  }

  if (opts.footer) parts.push(opts.footer);
  const out = parts.join(sep);
  return out.length > MEMBER_PROMPT_BUDGET ? out.slice(0, MEMBER_PROMPT_BUDGET) : out;
}

// The protected identity body: the authored charter.md, falling back to the
// record's charter when there is no readable file.
async function composeIdentity(membersRoot: string, member: Member): Promise<string> {
  const charterDoc = (await readMemberDoc(membersRoot, member.slug, "charter.md"))?.trim();
  return charterDoc && charterDoc.length > 0 ? charterDoc : member.charter.trim();
}

// The durable-memory + operating-rules section pair (each contributes only once
// it carries real content past the seed placeholder). The composer layers the log
// tail and footer on top.
async function memoryAndRulesSections(
  membersRoot: string,
  member: Member,
): Promise<PromptSection[]> {
  return [
    {
      title: "Durable memory",
      text: substance(await readMemberDoc(membersRoot, member.slug, "memory.md")),
      flex: false,
    },
    {
      title: "Operating rules",
      text: substance(await readMemberDoc(membersRoot, member.slug, "rules.md")),
      flex: false,
    },
  ];
}

// A member + its on-disk docs -> one direct-chat system prompt, <= the seed
// budget. Identity (charter, falling back to the record's charter) and the
// operating footer are protected; durable memory, rules, and the log tail fill
// the rest in that priority, the log truncating first.
export async function composeMemberSystemPrompt(
  membersRoot: string,
  member: Member,
): Promise<string> {
  return stackMemberPrompt({
    name: member.name,
    identity: await composeIdentity(membersRoot, member),
    sections: [
      ...(await memoryAndRulesSections(membersRoot, member)),
      {
        title: "Recent log",
        text: substance(await readMemberDoc(membersRoot, member.slug, "log.md")),
        flex: true,
      },
    ],
    footer: `## Direct-chat operating rules\n\n${DIRECT_CHAT_RULES}`,
  });
}

// The seed both entry points (the roster Enter action and the agent resolver)
// hand to the harness, so the two can never drift. Structurally the shared
// OpenChatSeed; the rib emits it as opaque action data, so it needn't import the
// type. Carries the member's model/provider when set so a seeded chat runs on it.
export async function buildSeedFor(
  membersRoot: string,
  member: Member,
): Promise<{
  systemPrompt: string;
  name: string;
  openingPrompt: string;
  model?: string;
  providerId?: string;
}> {
  return {
    systemPrompt: await composeMemberSystemPrompt(membersRoot, member),
    name: member.name.slice(0, 80),
    openingPrompt: ENTER_OPENING_PROMPT,
    // Provider-primary: pin the provider when set, and the model only alongside it, so
    // a seed never requests a model without its provider hint.
    ...(member.provider ? { providerId: member.provider } : {}),
    ...(member.provider && member.model ? { model: member.model } : {}),
  };
}

// A seeded doc counts as substance only if, with its markdown headers and the
// exact `_(empty)_` / `_(none yet)_` seed placeholders stripped, anything is
// left. So a brand-new member's template memory.md/rules.md contribute no section,
// but real content that happens to use an italic parenthetical is kept.
function substance(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const stripped = doc
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/_\((?:empty|none yet)\)_/g, "")
    .trim();
  return stripped.length > 0 ? doc.trim() : undefined;
}

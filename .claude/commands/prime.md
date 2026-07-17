---
description: Prime understanding of the Squad rib — the Rib surface, the coordinator run loop, the scope model, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working, current mental model of @keelson/rib-squad — fast enough to
    navigate it and respect its invariants before making a change. AGENTS.md
    (already in context) carries the stable contract, patterns, and invariants;
    this command's job is to discover what is true RIGHT NOW — the inventories,
    the surface layout, the seams — from the code itself. Report only what you
    derived this pass; never recall a count, layout, or name list from memory or
    from a doc.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below; for
      everything else, LIST and skim — don't deep-read.</rule>
    <rule>src/index.ts and src/coordinator.ts are large (thousands of lines —
      check with wc -l). NEVER read either whole. Find anchors with grep, not
      remembered line numbers:
      - index.ts: read from the line grep finds for `const rib: Rib =` to EOF,
        plus the module-singleton seam declarations near the top (grep `^let `).
        Skim the inline tool bodies between only if the task needs one.
      - coordinator.ts: read only the exported interfaces/consts the grep in
        phase 3 surfaces — never the round-loop body.</rule>
    <rule>DO NOT read test files — count them only.</rule>
    <rule>DO NOT read every board/collector/tool/casting file — read ONE of each
      as the pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>AGENTS.md / CLAUDE.md are already project context; build on them, don't
      re-read them. The code is the truth. If something you read materially
      contradicts AGENTS.md or a docs/ page, note it in ONE closing line and move
      on — auditing docs is not this command's job.</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough sizes, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
      <command>wc -l src/*.ts src/boards/*.ts src/casting/*.ts bin/*.ts | sort -rn | head -20</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <learn>The current pitch: what the rib adds, what it requires, how it
        installs and links into a local Keelson.</learn>
    </step>
  </phase>

  <phase number="2" name="the-rib-surface">
    <intent>The whole rib is one `Rib` object exported from src/index.ts — a flat
      assembly file (tool definitions, workflow prompts, and action handlers
      inline) over the domain modules in src/. Read the object; skim the rest.</intent>
    <step name="rib-object">
      <action>Locate and read the `Rib` object (grep `const rib: Rib =`, read to
        EOF) and the module-singleton seams near the top of the file.</action>
      <learn>Which views/keys exist and what surface layout binds them to which
        producer workflows; which regions carry cadence, `live`, or hideWhenEmpty
        and why.</learn>
      <learn>How contributeWorkflows shapes its two producer kinds and how each
        fails closed.</learn>
      <learn>What registerTools captures from ctx, what it registers imperatively,
        and what dispose tears down.</learn>
      <learn>How onAction guards action origin, and the full set of verbs it
        switches on. Trust the action STRINGS (defined where the boards emit
        them, src/boards/*.ts), not the constant names — they can differ.</learn>
      <learn>How listAgents/resolveAgent stay consistent with the roster Enter
        action.</learn>
    </step>
    <step name="types">
      <action>Read src/types.ts.</action>
      <learn>The Member record, its casting/identity fields, and the helpers the
        boards and stores share.</learn>
    </step>
    <step name="one-tool">
      <action>Read ONE tool implementation as the pattern (squad_emit_member is a
        good driver-free one); grep the full list rather than reading each.</action>
      <command>grep -nE 'name: "squad_' src/index.ts</command>
      <learn>The common tool shape: schema validation, scope resolution, the
        disk-op vs seam-call split, how seam-dependent tools fail closed, which
        tools require confirmation.</learn>
    </step>
  </phase>

  <phase number="3" name="producers-and-the-loop">
    <intent>Every panel is fed by a producer; the Run loop panel is fed by the
      long-running coordinator.</intent>
    <step name="collectors">
      <action>Read ONE collector + its board builder as the pattern
        (bin/collect-roster.ts → src/boards/roster.ts); list the rest of bin/ and
        src/boards/.</action>
      <learn>How a collector gets its data home, how it degrades instead of
        throwing, and which panel (if any) is NOT collector-fed and why.</learn>
    </step>
    <step name="coordinator">
      <action>Skim the top of src/coordinator.ts only, and list the method
        modules it delegates to.</action>
      <command>grep -nE 'export (interface|const|type|function) ' src/coordinator.ts | head -30</command>
      <command>grep -nE 'DEFAULT_LIMITS|maxRounds|maxStall|maxResets' src/orchestrator.ts | head</command>
      <learn>The ledger shape, the terminal-status union and which statuses get
        archived, the current bound limits, and what gates a "done" claim on a
        code-changing run.</learn>
      <learn>The step methods a round can take and which module implements each;
        how stop/steer reach a live run.</learn>
    </step>
  </phase>

  <phase number="4" name="scope-and-disk">
    <step name="scope">
      <action>Read src/paths.ts and skim src/scope.ts.</action>
      <learn>How a project maps to a scope directory, what the default-scope
        sentinel does, which files live at the data-home root regardless of
        scope, and what one member's directory contains.</learn>
    </step>
  </phase>

  <phase number="5" name="inventory">
    <intent>Derive every number you will report. These commands are the only
      legitimate source for counts — not AGENTS.md, not docs/, not memory.</intent>
    <command>grep -cE '^\s+name: "squad-' src/index.ts   # workflows</command>
    <command>grep -cE 'name: "squad_' src/index.ts        # chat tools</command>
    <command>git ls-files 'test/**/*.test.ts' 'test/*.test.ts' | wc -l   # test files</command>
    <command>ls .claude/commands/ 2>/dev/null</command>
  </phase>

  <phase number="6" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR — the required
      checks, commit/PR-title format, and architecture rules.</action>
  </phase>

  <phase number="7" name="summarize">
    <format>Concise markdown — no multi-page dump. Every count and layout claim
      must come from this pass's commands and reads.</format>
    <sections>
      <section>Project: 1–2 sentences.</section>
      <section>The Rib surface: views/surface as currently laid out, the producer
        shapes, the tool assembly + fail-closed rule, actions, agents.</section>
      <section>The coordinator loop: the round shape, the current limits and
        terminal statuses, the step methods.</section>
      <section>The scope model: per-project data isolation as implemented.</section>
      <section>Commands: the package scripts that gate a PR.</section>
      <section>Invariants bearing on the change at hand (from AGENTS.md, confirmed
        against what you just read).</section>
      <section>Where to start: which file to open first for this task.</section>
      <section>Only if found: one closing line naming any material contradiction
        between the code and AGENTS.md / docs/.</section>
    </sections>
  </phase>

  <anti-patterns>
    <avoid>Reading src/index.ts or src/coordinator.ts whole.</avoid>
    <avoid>Reading every board/collector/tool/casting file — one of each, list the rest.</avoid>
    <avoid>Reporting a count, layout, or name list you did not derive this pass.</avoid>
    <avoid>Turning orientation into a docs audit — one closing drift line at most.</avoid>
    <avoid>Launching subagents. A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>

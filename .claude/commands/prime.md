---
description: Prime understanding of the Squad rib — the Rib surface, the coordinator run loop, the scope model, and conventions
allowed-tools: Bash, Read, Glob, Grep
---

<prime-command>
  <objective>
    Build a working mental model of @keelson/rib-squad — a Keelson rib that adds a
    roster of named team members you author (genesis / auto-cast), each a first-class
    chat agent, plus a standing coordinator loop that plans, delegates, and verifies
    its own progress against a project's repo — fast enough to navigate it and
    respect its invariants before making a change.
  </objective>

  <constraints>
    <rule>Stay bounded. Read the few load-bearing files named below; for everything
      else, LIST and skim — don't deep-read.</rule>
    <rule>src/index.ts is ~4050 lines. Do NOT read it whole — read the `Rib` object at
      the tail (from `const rib: Rib =`, ~line 2655, to the end) plus the seam
      singletons at the top (~lines 160-210); SKIM the tool implementations between.</rule>
    <rule>src/coordinator.ts is ~2600 lines. SKIM the interfaces/consts at the top
      only (CoordinatorLedger, the RUN_STATUS_* set, RunCoordinatorOptions) — never
      the round-loop body.</rule>
    <rule>DO NOT read test files — count them only.</rule>
    <rule>DO NOT read every board/collector/tool/casting file — read ONE of each as
      the pattern, list the rest.</rule>
    <rule>DO NOT launch subagents — this is a single-pass orientation.</rule>
    <rule>CLAUDE.md / AGENTS.md are already project context; build on them, don't
      re-read. They track the current architecture, but the code is still the truth
      — if they disagree, believe the code and report it (see the drift phase).</rule>
  </constraints>

  <phase number="1" name="orient">
    <step name="layout">
      <action>Map the package shape — directories and rough size, not every file.</action>
      <command>git ls-files | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head -20</command>
      <command>wc -l src/*.ts src/boards/*.ts src/casting/*.ts | sort -rn | head -20</command>
    </step>
    <step name="readme">
      <action>Read README.md.</action>
      <extract>The pitch: author a roster of named members (a Lead, Engineer,
        Reviewer, Tester); each becomes a Keelson chat agent and a card on the Squad
        canvas surface; a standing coordinator plans/delegates/verifies against a repo;
        mixed providers per member; governed decision memory; a non-overridable policy
        floor (can open a PR, can never merge or force-push); zero React.</extract>
    </step>
  </phase>

  <phase number="2" name="the-rib-surface">
    <intent>The whole rib is one `Rib` object exported from src/index.ts. Unlike the
      chamber rib, index.ts is NOT a thin composition root — it holds the tool
      definitions, the workflow prompts, and the action handlers INLINE, and imports
      the domain logic from the modules under src/. Read the object; skim the rest.</intent>
    <step name="rib-object">
      <action>Read the `Rib` object (src/index.ts, `const rib: Rib =` to EOF) and the
        module-singleton seams captured near the top (refreshWorkflow, runAgentTurn,
        getProjects, getProviders, acquireWorkspace, registerOp).</action>
      <extract>views / the Squad surface (id "squad", projectScoped, hideRegionActions):
        the header ("The Squad", collapsible, with the retire-all head verb) plus FOUR
        one-region rows — Run loop (promoted, `live`), Proposed squad, Runs, Decisions.
        Each region binds a `rib:squad:*` snapshot key to a workflow; the content panels
        are `hideWhenEmpty`. Three more views (run-detail, report `html`, charter) are
        NOT regions — they are imperatively registered drill-downs.</extract>
      <extract>contributeWorkflows: the collectors (bash) + the prompt-turn workflows,
        each fail-closed (`output_schema` + `expectView` on the collectors;
        `fail_on_tool_error` + a named `allowed_tools` opt-in on the prompt turns).</extract>
      <extract>registerTools as the seam-capture + tool-assembly point: it is the only
        hook with the full ctx, so it captures ctx.getDataDir (bakes the data home
        BEFORE the roster bash node interpolates it), the seam singletons, and
        imperatively registers the run-detail + report snapshots. Every squad_* tool is
        returned UNCONDITIONALLY; seam-dependent tools (dispatch/code/coordinate/…) fail
        closed at call time with "seam unavailable" rather than being absent.</extract>
      <extract>contributePolicies → squadPolicies() (the governance floor); onAction (a
        verb switch — enter-member, select-project, coordinate, dispatch, assign-code,
        approve/discard-cast, record-decision, … — that rejects any `canvas-html`
        origin outright); listAgents/resolveAgent (every member enterable, both built
        from buildSeedFor so Enter and the agent seam can't drift); dispose (clears
        every captured seam so a re-boot recaptures the new ctx's).</extract>
    </step>
    <step name="types">
      <action>Read src/types.ts.</action>
      <extract>Member (the roster record + casting fields), the identity-slot helpers,
        normalizeToolAllowlist, and the "code" capability convention.</extract>
    </step>
    <step name="one-tool">
      <action>Read ONE tool as the pattern — makeEmitMemberTool (the genesis write
        seam) or makeCoordinateTool. LIST the rest by grepping their names.</action>
      <command>grep -nE 'name: "squad_' src/index.ts</command>
      <extract>The shape: a Zod inputSchema, `state_changing`, resolveRunScope (an
        explicit `project` arg or the selected scope), then a driver-free disk op or a
        seam call, emitting a bounded tool_result. The three tools that touch a real
        remote or working tree (squad_open_pr, squad_resolve_review, squad_rollback)
        also set `requires_confirmation`. The count re-derived by the grep is the
        truth — trust it over any prose number (see the drift phase).</extract>
    </step>
  </phase>

  <phase number="3" name="the-two-producer-shapes">
    <intent>Every panel is fed by one of two producers: a cheap deterministic bash
      collector, or (for the Run loop) the long-running coordinator loop.</intent>
    <step name="collectors">
      <action>Read ONE collector + its builder as the pattern
        (bin/collect-roster.ts → src/boards/roster.ts); LIST the rest.</action>
      <extract>A collector is an out-of-process bash node (`bun bin/collect-*.ts
        <dataHome>`) that reads a file off the data home and prints a `board` view; the
        pure builder in src/boards/ shapes it. Four board collectors (roster, cast,
        coordinator, runs) + count-members; six board builders (roster, cast,
        coordinator, runs, decisions, charter). decisions is the exception — a cheap
        count node then a paid recall+render turn, not a bash collector, which is why
        its region carries no cadence. charter has no collector: it is a drill-down the
        cast board's view-charter verb publishes.</extract>
    </step>
    <step name="coordinator-loop">
      <action>SKIM src/coordinator.ts (interfaces/consts at the top ONLY) and LIST the
        method modules.</action>
      <command>grep -nE 'export (interface|const|type) (Coordinator|RunCoordinator|Verification|RUN_STATUS|LEDGER_STATUS|MAX_)' src/coordinator.ts | head</command>
      <extract>The round: recall (governed memory, once) → assess (one manager turn
        judging progress) → pick a method → execute one step → reflect (a repeat-outcome
        stall forces a re-plan). The CoordinatorTerminalStatus union: done, gave-up,
        max-rounds, max-tokens, verification-failed, change-quality-failed, aborted.
        archiveRun fires for EVERY terminal status (aborted included); only "error" —
        which is not in the union — escapes archival. A "done" claim is not trusted for
        a code-changing run until an independent review and the project's own verify
        commands come back clean.</extract>
      <extract>The three methods a step can take (method agency): dispatch.ts (text-only
        fan-out), code.ts + turn-runner.ts (a confined coding turn, write-railed to the
        project root), and workflow-authoring.ts (author a reusable DAG). orchestrator.ts
        holds DEFAULT_LIMITS; live-runs.ts / the activeCoordinateRuns + pendingSteers maps
        back stop/steer; rollback.ts + rollback-store.ts preview undoing a failed run.</extract>
    </step>
  </phase>

  <phase number="4" name="scope-and-disk">
    <intent>A squad-distinctive invariant: everything is per-project scoped on disk.</intent>
    <step name="scope">
      <action>Read src/paths.ts and skim src/scope.ts.</action>
      <extract>A scope is a data-isolation boundary, one per project, under
        `{keelson-home}/rib-squad/`. The DEFAULT_SCOPE_ID sentinel maps onto the flat
        home root (so a pre-scoping roster is never orphaned); every other project maps
        onto `projects/{segment}/`, the id sanitized to a bare token (or a stable hash
        on collision). selected-project.json + projects.json live at the root regardless
        of scope (the out-of-process collectors read them via argv before they can
        resolve a scope). A member is one dir: member.json + charter.md + memory.md +
        rules.md + log.md, keyed by a slug guarded by assertSafeSlug before any I/O.</extract>
    </step>
  </phase>

  <phase number="5" name="inventory">
    <step name="tests">
      <action>Count test files; report the count only.</action>
      <command>git ls-files 'test/**/*.test.ts' 'test/*.test.ts' | wc -l</command>
    </step>
    <step name="workflows-and-tools">
      <action>Re-derive the real counts from code (the docs drift — see phase 8).</action>
      <command>grep -cE '^\s+name: "squad-' src/index.ts   # workflows</command>
      <command>grep -cE 'name: "squad_' src/index.ts        # chat tools</command>
    </step>
    <step name="commands"><command>ls .claude/commands/ 2>/dev/null</command></step>
  </phase>

  <phase number="6" name="conventions">
    <action>Skim CONTRIBUTING.md for the rules that gate a PR.</action>
    <points>
      <point>Green before a PR: `bun run check` (Biome), `bun run typecheck` (needs
        @keelson/shared linked), `bun test` (runs on stubs).</point>
      <point>Invariants: zero React (boards, never hand-coded UI); attach only via the
        `Rib` contract; fail closed everywhere (expectView + output_schema on
        collectors, fail_on_tool_error on genesis, slug/collision guards in the stores);
        the governance floor is non-overridable (no self-merge, no force-push; a BLOCK
        review verdict fails a workflow-surface run); per-project scope isolation; fresh
        seam capture per boot, cleared in dispose; coordinator runs are bounded
        (maxRounds/maxStall/maxResets); a confined coding turn is write-railed to the
        project root.</point>
      <point>Comments: default to none; capture non-obvious why; no narration.</point>
      <point>No abstractions ahead of a concrete second caller.</point>
      <point>Commits/PR title are conventional commits (the squashed title feeds
        release-please); workflow descriptions use the Use when / Triggers / Does / NOT
        for shape.</point>
    </points>
  </phase>

  <phase number="7" name="summarize">
    <format>Concise markdown — no multi-page dump:</format>
    <sections>
      <section>Project: 1–2 sentences (a Keelson rib; a roster of authored members + a
        standing coordinator loop over a repo).</section>
      <section>The Rib surface: views/surface, the two producer shapes, the tool
        assembly + seam-dependent fail-closed rule, actions, agents — and index.ts as a
        flat assembly (tool defs + prompts inline) over the src/ domain modules.</section>
      <section>The coordinator loop: recall → assess → pick a method → execute one step
        → reflect, gated by review + verify before "done"; dispatch / code / workflow as
        the three methods.</section>
      <section>The scope model: per-project data isolation under rib-squad/.</section>
      <section>Commands: test / typecheck / check / check:fix / link:keelson.</section>
      <section>Invariants to respect for the change at hand (esp. the governance floor,
        scope isolation, and fail-closed producers).</section>
      <section>Where to start: which file to open first.</section>
    </sections>
  </phase>

  <phase number="8" name="report-drift">
    <action>This rib moves fast and the docs lag. If anything you read contradicts this
      command file, AGENTS.md, or the docs/ reference pages, SAY SO in a closing line —
      name the file and the specific claim. The greps in phase 5 re-derive the real
      counts; trust them over any prose number, in the docs or in this file.</action>
    <points>
      <point>As of 2026-07-16 the counts in AGENTS.md and the docs/ reference pages
        (17 tools, 12 workflows, 23 action verbs, 8 views) match the code. Re-derive
        anyway — that is the point of the phase-5 greps, and a stale number here is
        itself drift worth reporting.</point>
      <point>Read the verb STRINGS off src/boards/*.ts, never off the constant names in
        the switch — three disagree: STOP_COORDINATOR_ACTION is "stop-coordinate",
        STEER_COORDINATOR_ACTION is "steer-coordinate", and REPORT_RUN_ACTION is
        "squad-report".</point>
    </points>
  </phase>

  <anti-patterns>
    <avoid>Reading src/index.ts or src/coordinator.ts whole — read the Rib object /
      the interfaces, skim the bodies.</avoid>
    <avoid>Reading every board/collector/tool/casting file — read one of each, list the rest.</avoid>
    <avoid>Trusting the docs' or this file's counts over the code — the greps are the contract.</avoid>
    <avoid>Launching subagents. A multi-page summary.</avoid>
  </anti-patterns>
</prime-command>

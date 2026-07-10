# Security Policy

Thanks for taking the time to make the Squad rib safer.

## Supported versions

The Squad rib is pre-1.0 (`0.x`) software. Security fixes land on the
latest minor release line only. Once 1.0 ships, this policy will document
a longer support window.

| Version                         | Supported          |
|---------------------------------|--------------------|
| Latest `0.x` minor release line | :white_check_mark: |
| Any older release               | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Public
issues become indexable the moment they're created and give an attacker
a head start on any users who haven't updated yet.

Instead, report privately via one of these channels:

- Email: **degnome@gmail.com** with subject line `[squad security]`
- GitHub private vulnerability report:
  <https://github.com/danielscholl/keelson-rib-squad/security/advisories/new>

A useful report includes:

- A description of the issue and the impact you observed (or believe is
  possible)
- The Squad rib version, your Keelson version (`keelson version --json`),
  Bun version (`bun --version`), and OS where you reproduced it
- A minimal proof-of-concept or reproduction steps
- Any mitigations or workarounds you've found

I'll acknowledge new reports within **3 business days** and aim to have a
fix or mitigation plan within **14 days** of acknowledgement, faster for
issues with a public PoC or active exploitation. If a report turns out
to be out of scope, I'll explain why.

## Scope and threat model

Squad is a **Keelson rib** — a capability package installed into the
Keelson harness and discovered at boot. It runs a coordinator that writes
code, opens GitHub pull requests, and calls provider APIs. A rib runs with
the same privileges as the harness, so the threat model assumes:

- The operator trusts their own machine, the harness, and the ribs they
  install (vet a rib before installing it — a malicious rib is equivalent
  to malicious local code and is **outside** this threat model).
- Hostile inputs may arrive over the network from provider responses,
  member turn outputs, GitHub API responses, tool outputs, or fetched
  URLs.

### In scope

- Command injection or path traversal in any rib handler that splices
  untrusted data (provider output, member turn output, GitHub API
  responses, upstream node output, workflow YAML fields) into a shell,
  child process, or filesystem path
- Credential or secret leakage: any path where the rib logs, snapshots,
  or transmits provider tokens, GitHub tokens, or other secrets it handles
- Missing redaction of secrets the rib surfaces into snapshots or tool
  output

### Out of scope

- The Keelson harness itself (the OS keychain store, the server, the
  redaction engine) — report those at
  <https://github.com/danielscholl/keelson>
- Behavior under a hostile rib (treat ribs as trusted code; vet them
  before installing them)
- Issues that require a hostile party to already have local code-
  execution or filesystem access on the operator's machine
- Provider-side issues (Copilot SDK, Claude Agent SDK, Codex) — please
  report those upstream
- Cosmetic issues, denial-of-service via large inputs to local-only
  surfaces, and CSS / a11y bugs (file those as regular issues)

## Disclosure

After a fix lands and is released, I'll publish a GitHub security
advisory with a CVE if one is warranted, credit the reporter (unless
they prefer to stay anonymous), and link to the relevant commits and
release notes.

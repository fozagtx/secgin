---
name: secgin
description: Guide for the local-source VDH/VVS security research harness. Use when the operator wants authorized Web2/Web3/AI source review, MCP tools harness_plan harness_run harness_status, x-ray, solidity-auditor, fizz, or Pashov skills. Not a canned audit product and not a live scanner.
license: MIT
compatibility: Requires a host that loads Agent Skills and MCP (Agent Plugins 1.0, Gemini CLI, or any CLI/cloud agent with those surfaces).
---

# secgin

This Skill teaches **the host agent** how to operate the harness. The host is whatever TUI or cloud agent loaded this plugin. The JSON worker is the backbone; it does not care which app spawned it. Worker models are bug-bounty hunters: Web2 or smart-contract bugs that an attacker could cash in. Impact first. MCP tools `harness_models`, `harness_plan`, `harness_run`, `harness_status`, and `harness_evaluate` spawn that worker. Do not invent a target, demo finding, or mock client.

## First actions

1. Confirm the operator has a real `scope.json` beside a tree they control. Required keys are documented in the README section "scope.json". There is no example target.
2. Call `harness_models`. Entries carry `hasCredentials`; only pick models whose provider has credentials. Pick **three different catalog models** (recon, hunter, validator) — prefer hunter and validator on different providers so they cross-check. Hunt compute is whatever `{provider,id}` pairs are in their `scope.json` (e.g. `openai/gpt-5`, `anthropic/claude-sonnet-4-5`, `minimax/MiniMax-M2.7`, `google/gemini-2.5-pro`, `openai-compatible/<local-model>`, `agent/coding-agent`).
3. Call `harness_plan` with their `scope.json`. Fix the scope until it succeeds. Web3 plans must list twelve `hunt:web3:*` cells; ai plans list six `hunt:ai:*` cells.
4. Only then call `harness_run` with `confirmed=true`, their scope, and an output directory **outside** the source root. That run is recon/x-ray → optional fizz → selected domain hunt cells (including twelve auditor hunts for web3) → validate → VVS.
5. After a run: `harness_status`. Confirmed findings stay **0** until a human reproduces.

## What a run does

Recon reads the source first and writes an intent model (components, actors and trust levels, entry points, trust boundaries, invariants) without hunting. Every hunt cell receives that model as protocol context and checks, invariant by invariant, whether a reachable path breaks it. Hunt passes (`limits.passes`) run in sequence; each later pass is told what earlier passes already reported and looks elsewhere. An isolated validator model then tries to disprove each candidate. Tell the operator this when they ask how the harness reasons; do not re-implement it by prompting models yourself.

Reading results: `architecture.md` is the intent model recon wrote; if it misreads the protocol, say so, because every hunt inherited that reading. `findings.json` statuses are `needs-reproduction` (validator could not disprove; a human must reproduce), `needs-context`, `rejected`, `unvalidated`. Candidate quality bar: hunters escalate each real defect to the strongest variant its cited lines support (severity follows cited reach; marked inference never raises it) and auto-reject informational-only and best-practice noise; validators downgrade hollow reproductions to needs-context.

x-ray, solidity-auditor, and fizz are names for harness stages. Call `harness_run`. Do not execute vendored Pashov playbooks (`enumerate.sh`, forge coverage, Echidna, Medusa). Models declare VDH/VVS tools; they cannot execute tools, patches, or tests.

The mdpsec packs are vendored under `mdpsec/` (`bug-bounty-hunting-prompts`, `should-i-submit`). Their rubrics are already inside the prompts (`mdpsec.ts` constants; see `mdpsec/HARNESS.md`). Never run the phase files, the browser/account/OOB tooling, or should-i-submit's live validation mode. The report's pre-submit gate answers NO, NOT YET, or CANNOT DECIDE SAFELY only — never YES.

## Reproducing with Drost (optional, separate MCP)

The operator may also register [Drost Community Edition](https://github.com/drost-ai/drost-community) (`drost_*` tools, a live Kali container). It is a separate MCP server, not part of secgin: the harness tools and worker never call it, and the "no live scan, no exploit execution" rules above still bind every secgin stage.

Use Drost tools only when the operator explicitly asks to reproduce a named candidate. Then:

1. Confirm the target is a local or isolated copy the operator owns or is authorized to test. If that is not clear, ask before any `drost_*` call. Never point Drost at a production host, a public chain, or a third-party system.
2. Create one engagement with `drost_engagement_create` listing only that target, and pass its `engagement_id` to every Drost call.
3. Follow only the candidate's `reproduction` steps and `preconditions` from `findings.json`. Use the narrowest tool for each step (`drost_http_*` workbench, `drost_browser_*`, `drost_jwt_audit`, `drost_graphql_audit`, `drost_openapi_audit`). Do not run broad recon or scanning workflows (subfinder, amass, nmap, nuclei sweeps) that the steps do not need.
4. Report the expected secure behavior, the actual result, and the Drost artifact paths. Do not call the candidate confirmed: the operator decides, and records it in `labels.json` for `harness_evaluate`.

## Long-term memory with Supermemory (optional, separate MCP)

The operator may register [Supermemory](https://supermemory.ai/) as a separate MCP server so lessons persist across sessions and audits (Web2 or Web3). secgin tools and the worker never call it; it is host-agent memory only.

Before a run, if Supermemory tools are present, recall lessons for the target's stack and domain (e.g. "web3 lending oracle", "web2 express auth") and use them to shape the scope and to read results. Never feed recalled text into a model as a finding.

After `harness_status`, and again after the operator labels candidates, store one lesson per useful outcome:

- Stack and domain, the bug class, and how it was found (which hunt cell, which invariant from `architecture.md`).
- Outcome only as the operator stated it: reproduced, false positive, or unknown. Never store a candidate as confirmed on model output alone.
- What to do differently next time (scope fix, missed component, recon misread).

Do not store source code, secrets, credentials, private hostnames, or unreported exploit details. Store patterns, not payloads.

When the operator asks to update the shared knowledge base, append the same generalized lessons to [`LESSONS.md`](LESSONS.md) (one entry per lesson, no target names unless public and already disclosed) and commit it to the repo. Do not change prompts or `PROMPT_VERSION` from a lesson unless the operator asks for a prompt change.

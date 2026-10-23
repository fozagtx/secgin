---
name: secgin
description: Guide for the local, agent-driven VDH/VVS security research harness. Use when the operator wants authorized Web2/Web3/AI source review, MCP tools harness_plan harness_run harness_next harness_submit harness_status, x-ray, solidity-auditor, fizz, or Pashov skills. Not a canned audit product and not a live scanner.
license: MIT
compatibility: Requires a host that loads Agent Skills and MCP (Agent Plugins 1.0, Gemini CLI, or any CLI/cloud agent with those surfaces).
---

# secgin

This Skill teaches **the host agent** how to operate the harness. The host is whatever TUI or cloud agent loaded this plugin — and **you, that agent, are the only model**. secgin calls no provider, holds no API key, and sends nothing off the machine. It runs the VDH/VVS pipeline locally, parks each stage's prompt, and hands it to you to reason about; you answer, it advances. Hunt like a bug-bounty hunter: Web2 or smart-contract bugs an attacker could cash in, impact first. MCP tools: `harness_plan`, `harness_run`, `harness_next`, `harness_submit`, `harness_status`, `harness_evaluate`. Do not invent a target, demo finding, or mock client.

## The loop

1. Confirm the operator has a real `scope.json` beside a tree they control. Required keys are in the README section "scope.json". There is no example target, and the config names **no models** — you are the model.
2. Call `harness_plan` with their `scope.json`. Fix the scope until it succeeds. Web3 plans must list twelve `hunt:web3:*` cells; ai plans list six `hunt:ai:*` cells.
3. Call `harness_run` with `confirmed=true`, their scope, and an output directory **outside** the source root. It returns `status: "need-agent-work"` with a `pending` array of prompts.
4. For each pending item: read its `system` + `prompt`, act in its `role` (recon maps the target; hunter looks for defects; validator adversarially disproves candidates), and produce **exactly** the JSON object the prompt specifies — nothing else, no prose, no fences. Dispatch independent items to parallel sub-agents, and keep hunting and validation on **separate reads** (ideally a fresh sub-agent for validation) so they cross-check. Then call `harness_submit` with `answers: [{id, text}]`, one entry per item, `text` being your JSON string.
5. `harness_submit` returns the next `need-agent-work` batch. Repeat until it returns `status: "complete"` (or `incomplete`). `harness_next` re-fetches the current batch if you lose it. If the server restarts, call `harness_run` again with the same output — it resumes instantly from saved state.
6. The final report is gated (Wave 4). On completion secgin writes the working artifacts but withholds `report.md`/`report.json` until the operator drops an empty `FINAL_REPORT_AUTHORIZED` file in the output directory; then call `harness_run` again to emit them. After a run, `harness_status` summarizes. Confirmed findings stay **0** until a human reproduces.

secgin reads source only. Never run the target, exploits, patches, or tests — not as a stage answer, not on the side.

## Waves

- **Wave 0 — recon.** You read the source first and write an intent model (components, actors and trust levels, entry points, trust boundaries, invariants) without hunting.
- **Wave 1 — hypotheses.** secgin derives `HYPOTHESES.jsonl` from that recon: one target-derived, testable claim per line.
- **Wave 2 — investigate.** Every hunt cell receives the intent model as protocol context and checks, invariant by invariant, whether a reachable path breaks it. Hunt passes (`limits.passes`) run in sequence; each later pass is told what earlier passes already reported and looks elsewhere.
- **Wave 3 — adjudicate.** An independent validator read tries to disprove each candidate; dedup, judgment and fix-proposal stages follow. This is why you keep validation on a separate read from hunting.
- **Wave 4 — reconcile.** `INVESTIGATION_PLAN.json` records coverage and the funnel; the final report is written only after `FINAL_REPORT_AUTHORIZED`.

Tell the operator this when they ask how the harness reasons. Do not re-implement the pipeline by free-form prompting yourself — answer the parked prompts secgin gives you.

Reading results: `architecture.md` is the intent model recon wrote; if it misreads the protocol, say so, because every hunt inherited that reading. `findings.json` statuses are `needs-reproduction` (validator could not disprove; a human must reproduce), `needs-context`, `rejected`, `unvalidated`. Candidate quality bar: hunters escalate each real defect to the strongest variant its cited lines support (severity follows cited reach; marked inference never raises it) and auto-reject informational-only and best-practice noise; validators downgrade hollow reproductions to needs-context.

x-ray, solidity-auditor, and fizz are names for harness stages, reached through the normal run loop. Do not execute vendored Pashov playbooks (`enumerate.sh`, forge coverage, Echidna, Medusa). The pipeline may declare VDH/VVS tools (sibling hunts, gapfills, wishlist); it never executes tools, patches, or tests.

The mdpsec packs are vendored under `mdpsec/` (`bug-bounty-hunting-prompts`, `should-i-submit`). Their rubrics are already inside the prompts (`mdpsec.ts` constants; see `mdpsec/HARNESS.md`). Never run the phase files, the browser/account/OOB tooling, or should-i-submit's live validation mode. The report's pre-submit gate answers NO, NOT YET, or CANNOT DECIDE SAFELY only — never YES.

## Reproducing with Drost (optional, separate MCP)

The operator may also register [Drost Community Edition](https://github.com/drost-ai/drost-community) (`drost_*` tools, a live Kali container). It is a separate MCP server, not part of secgin: the harness tools and worker never call it, and the "no live scan, no exploit execution" rules above still bind every secgin stage.

Use Drost tools only when the operator explicitly asks to reproduce a named candidate. Then:

1. Confirm the target is a local or isolated copy the operator owns or is authorized to test. If that is not clear, ask before any `drost_*` call. Never point Drost at a production host, a public chain, or a third-party system.
2. Create one engagement with `drost_engagement_create` listing only that target, and pass its `engagement_id` to every Drost call.
3. Follow only the candidate's `reproduction` steps and `preconditions` from `findings.json`. Use the narrowest tool for each step (`drost_http_*` workbench, `drost_browser_*`, `drost_jwt_audit`, `drost_graphql_audit`, `drost_openapi_audit`). Do not run broad recon or scanning workflows (subfinder, amass, nmap, nuclei sweeps) that the steps do not need.
4. Report the expected secure behavior, the actual result, and the Drost artifact paths. Do not call the candidate confirmed: the operator decides, and records it in `labels.json` for `harness_evaluate`.

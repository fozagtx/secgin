# Pashov skills in this harness

Cloned from https://github.com/pashov/skills (see `ORIGIN`). MIT license in `LICENSE`.

| Skill | Harness mapping | Not executed |
| --- | --- | --- |
| `x-ray/` | VDH recon + `x-ray.md` | `enumerate.sh`, forge/hardhat coverage, git security script |
| `solidity-auditor/` | twelve `vdh.hunt` cells | shell `find`, live Agent spawn outside the orchestrator, `assemble.sh`, `.solidity-auditor/` runs/memory ledger, loop-mode pass picker |
| `fizz/` | `pashov.fizz` propose-only | Echidna, Medusa, Foundry, writes into the target |

solidity-auditor v4 loop mode maps to secgin's sequential hunt passes: each later pass receives an already-found list. Its report-language rules (`references/report-language.md`, Simplified Technical English) are folded into the hunt prompt for finding titles and rootCause.

The host agent loads Skill `secgin` (MCP tools `harness_plan` / `harness_run`). That Skill forbids running the vendored scripts. Original `SKILL.md` files stay as the upstream source of truth.

Evals/benchmarks from upstream were not copied (no canned targets).

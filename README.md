# secgin

A security research harness your coding agent drives. Give the agent a source tree you are authorized to test (Web2 service, AI/agent surface, Solidity contracts) and a `scope.json`; it plans and runs a vulnerability-discovery pipeline (VDH → VVS, after [Cloudflare's design](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)) and hands you candidates to reproduce. Works with any agent that loads Agent Skills or MCP.

Your agent **is** the model. secgin calls no provider, holds no API key, and sends nothing off the machine: it runs the VDH/VVS pipeline locally and hands each stage's prompt back to the driving agent to reason about. The agent only reads source and declares candidates. No target requests, exploits, tool execution, patches, or live scans. Nothing is ever marked confirmed until a human reproduces it.

## How it hunts

Two ideas from [Give Your AI Agent Context](https://0xasen.xyz/give-your-ai-agent-context) shape the pipeline:

1. **Intent before bugs.** A model reading raw code can only reason about what the syntax shows it; a guarantee it was never told about is one it cannot check. So recon runs first (three passes: architecture, threats, invariants; then a synthesis) and writes down what the protocol is supposed to guarantee: components, actors and their trust levels, entry points, trust boundaries, invariants. It is explicitly told not to look for bugs. Every hunt then receives that document as protocol context and is asked, invariant by invariant, whether a reachable path breaks it, with cross-file invariants called out because a single-file reading misses them.
2. **More than one look, each told what came before.** A single pass settles on whatever it notices first. Hunt passes run in sequence; every later pass gets the list of findings earlier passes already reported and is told to go where they did not. Rejected patterns from validation are excluded the same way. Cells that come back empty are gapfilled with a fresh look.

Where the article stops, the harness continues: many specialist lenses (eight Web2, six AI/agent, twelve Solidity from [Pashov](https://github.com/pashov/skills)) reason in parallel instead of one hunter looping; an independent validator read tries to disprove every candidate and cites the lines that settle it; VVS dedups, judges, and proposes fixes. Because the driving agent fulfils every role, keep hunting and validation on separate reads (a fresh sub-agent for validation) so they still cross-check. The one gap the article leaves open remains open here too: the context document is a model's reading, so hunters are told to trust the code over it and flag contradictions, but nothing independently checks recon. Hunters escalate each real defect to the strongest variant its cited lines support — severity follows cited reach, never inference — and reproduction steps must stand alone before a validator calls a candidate supported.

Pipeline, as waves: **0** recon → **1** hypotheses (`HYPOTHESES.jsonl`) → **2** hunt (sequential passes × lens) → **3** validate → reverify → gapfill → dedup → trace → feedback → judge → fix → **4** reconcile (`INVESTIGATION_PLAN.json`) → report. State lives in SQLite under the output directory; a run with the same output directory resumes. The final `report.md`/`report.json` is withheld until you drop a `FINAL_REPORT_AUTHORIZED` marker (Wave 4 gate); the working artifacts are written as soon as the pipeline completes.

## Install

Requirements: Node.js >= 22.19 (no build step). No API keys — the agent that starts the MCP server is the only model.

```bash
git clone https://github.com/fozagtx/secgin && cd secgin
node install-plugin.mjs --host <host>
```

| `--host` | Installs to | Notes |
| --- | --- | --- |
| `claude` | `~/.claude/plugins/secgin` | or `claude plugin marketplace add fozagtx/secgin && claude plugin install secgin@secgin` |
| `codex` | `~/.codex/plugins/secgin` | registered in `~/.agents/plugins/marketplace.json` |
| `minimax` | `~/.minimax-code/plugins/secgin` | |
| `gemini` | `~/.gemini/plugins/secgin` | registered in `~/.gemini/settings.json` (`GEMINI_CLI_HOME` overrides the root) |
| `cloud` | `~/.secgin` | for remote agents: `node ~/.secgin/server.mjs --http --port 8787` and register `http://127.0.0.1:8787/mcp` |
| `dest --path DIR` | any directory | every other agent, see below |
| `all` | claude + codex + minimax + gemini | |

Restart the agent afterwards. Re-run the same command to update.

**Any other agent** (Cursor, Windsurf, Cline/Roo, VS Code, OpenCode, ...): install with `--host dest --path DIR`, point the agent at `DIR/skills/secgin/SKILL.md` (rules or skills directory), and register the MCP server using the absolute path the installer printed:

```json
{ "mcpServers": { "secgin": { "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```

Codex uses `[mcp_servers.secgin] command = "node" args = [...]` in `~/.codex/config.toml`; VS Code uses `servers.secgin` with `"type": "stdio"`; OpenCode uses `mcp.secgin` with `"type": "local"`. The agent should see tools `harness_plan`, `harness_run`, `harness_next`, `harness_submit`, `harness_status`, `harness_evaluate`.

## No model providers

secgin used to call MiniMax/OpenAI/Anthropic/etc. with your API keys. It no longer does. The whole pipeline runs **in-process** in the MCP server, and every stage's prompt is handed back to the driving agent — the TUI or cloud agent that launched the server — which is the only model. There are no keys, no catalog, and no `harness_models` tool. This is the same shape as a local tool-server like Drost: a local MCP any agentic app can drive.

The agent plays three roles the pipeline keeps distinct — recon (maps the target), hunter (finds defects), validator (adversarially disproves candidates). Fulfil them on separate reads, ideally dispatching hunting and validation to different sub-agents, so they cross-check.

## Use

Write a `scope.json` beside or above the code, then ask your agent:

> Audit ./api with secgin. Scope is ./api/scope.json, output to ../secgin-out/api.

The Skill walks the agent through the loop:

1. `harness_plan` — offline scope validation + planned waves.
2. `harness_run` (`confirmed=true`, output **outside** the source root) — returns `status: "need-agent-work"` with a `pending` array of prompts.
3. For each pending item, reason in its `role` and return **exactly** the JSON the prompt asks for, then `harness_submit` with `answers: [{id, text}]`.
4. Repeat (`harness_submit` returns the next batch; `harness_next` re-fetches the current one) until `status: "complete"`.
5. To emit the final report, create an empty `FINAL_REPORT_AUTHORIZED` file in the output directory and call `harness_run` again — it resumes instantly from saved state. Re-running with the same output also resumes an interrupted run.

After you reproduce candidates, hand the agent a `labels.json` and ask for `harness_evaluate` to score the run.

### scope.json

All keys required, unknown keys rejected. Note there is **no** `models` block — the agent is the model.

```json
{
  "version": 1,
  "name": "acme-api-review",
  "authorization": { "reference": "SOW #1234", "expiresAt": "2026-12-31T23:59:59Z" },
  "root": ".",
  "files": ["src/auth/session.ts", "contracts/Vault.sol"],
  "domains": ["web2", "web3"],
  "limits": { "maxCalls": 400, "maxInputChars": 1500000, "maxOutputTokens": 32000, "timeoutMs": 1800000, "concurrency": 4, "passes": 2, "maxFindingsPerTask": 10 }
}
```

- `authorization`: `reference` is your attestation (SOW/ticket); `expiresAt` is an ISO-8601 UTC time in the future.
- `root`/`files`: relative, no `..`, no symlinks, 1–500 text source files; `.env`, keys, `.ssh/`, `.git/` rejected.
- `domains`: any of `web2`, `web3`, `ai`.
- `limits.passes`: sequential hunt passes per lens (1–3). Caps: `maxCalls` 1000, `maxInputChars` 2,000,000, `maxOutputTokens` 100,000, `timeoutMs` 3,600,000, `concurrency` 8, `maxFindingsPerTask` 20. `concurrency` is how many prompts secgin hands you per turn.

### Output

Working artifacts, written as soon as the pipeline completes: `architecture.md` (the intent model recon wrote), `HYPOTHESES.jsonl` (Wave 1), `INVESTIGATION_PLAN.json` (Wave 4 coverage/funnel), `x-ray.md`, `fizz-proposed.md` (web3, invariant properties proposed, never executed), `findings.json` / `FINDINGS-DETAIL.md` with each candidate as `needs-reproduction`, `needs-context`, `rejected`, or `unvalidated`. The gated final report — `report.md` / `report.json` — appears only after you drop `FINAL_REPORT_AUTHORIZED` and re-run.

## Reproducing candidates with Drost (optional helper)

secgin stops at `needs-reproduction`: it reads source and never touches a running system. To reproduce a candidate yourself, you can add [Drost Community Edition](https://github.com/drost-ai/drost-community) as a second, separate MCP server. Drost is a Kali-based Docker container with live tools (HTTP repeater, headless browser, API/JWT/GraphQL audits, nuclei, sqlmap, a shell, ...). secgin never calls Drost, does not install it, and does not read its results.

1. Install and start the container (needs Docker): `curl -fsSL https://drost.ai/community/install.sh | bash`, then check it with `docker exec drost-ai drost-mcp --self-test`.
2. Register it next to secgin in the same agent:
   - Claude Code: `claude mcp add --scope project drost -- docker exec -i drost-ai drost-mcp`
   - Codex: `codex mcp add drost -- docker exec -i drost-ai drost-mcp`
   - Gemini CLI: `gemini mcp add --scope project drost docker exec -i drost-ai drost-mcp`
   - Any other MCP client: `{ "mcpServers": { "drost": { "command": "docker", "args": ["exec", "-i", "drost-ai", "drost-mcp"] } } }`
3. Pick a `needs-reproduction` candidate from `findings.json` and run an isolated copy of the same source snapshot that you own (local service, test accounts, local chain fork).
4. Ask your agent, for example:
   > Reproduce candidate `<candidate id>` from ../secgin-out/api/findings.json with Drost against http://127.0.0.1:3000.

   The agent creates a Drost engagement for that local target (`drost_engagement_create`) and follows only that candidate's reproduction steps.
5. You decide whether it reproduced. Record it as a `classifications` entry (`true-positive` / `false-positive` / `unknown`) in your `labels.json` and run `harness_evaluate`. secgin's report still says confirmed 0; a Drost result is your evidence, not a secgin verdict.

Use Drost only against systems you own or are explicitly authorized to test. The `scope.json` authorization covers source review, not live targets. Drost fits Web2, API, and AI/agent candidates best; Web3 candidates are usually reproduced with a local Foundry or Hardhat test instead.

## Notes

- Vendored Pashov x-ray / solidity-auditor / fizz skills are reference material mapped onto stages (`pashov/HARNESS.md`); their scripts never run.
- Vendored mdpsec prompt packs under `mdpsec/` contribute rubrics and a deterministic pre-submit gate only; their live phases, browser/account/OOB tooling, and should-i-submit live validation are never executed.
- Rules for agents editing this repository: `AGENTS.md`.
- Drost is an optional, separate helper for operator-driven reproduction (see "Reproducing candidates with Drost"); secgin never calls it.

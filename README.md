# secgin

A security research harness your coding agent drives. Give the agent a source tree you are authorized to test (Web2 service, AI/agent surface, Solidity contracts) and a `scope.json`; it plans and runs a vulnerability-discovery pipeline (VDH → VVS, after [Cloudflare's design](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)) and hands you candidates to reproduce. Works with any agent that loads Agent Skills or MCP.

Models only read source and declare candidates. No target requests, exploits, tool execution, patches, or live scans. Nothing is ever marked confirmed until a human reproduces it.

## How it hunts

Two ideas from [Give Your AI Agent Context](https://0xasen.xyz/give-your-ai-agent-context) shape the pipeline:

1. **Intent before bugs.** A model reading raw code can only reason about what the syntax shows it; a guarantee it was never told about is one it cannot check. So recon runs first (three passes: architecture, threats, invariants; then a synthesis) and writes down what the protocol is supposed to guarantee: components, actors and their trust levels, entry points, trust boundaries, invariants. It is explicitly told not to look for bugs. Every hunt then receives that document as protocol context and is asked, invariant by invariant, whether a reachable path breaks it, with cross-file invariants called out because a single-file reading misses them.
2. **More than one look, each told what came before.** A single pass settles on whatever it notices first. Hunt passes run in sequence; every later pass gets the list of findings earlier passes already reported and is told to go where they did not. Rejected patterns from validation are excluded the same way. Cells that come back empty are gapfilled with a fresh look.

Where the article stops, the harness continues: many specialist lenses (eight Web2, six AI/agent, twelve Solidity from [Pashov](https://github.com/pashov/skills)) reason in parallel instead of one hunter looping; an isolated validator model tries to disprove every candidate and cites the lines that settle it; VVS dedups, judges, and proposes fixes. The one gap the article leaves open remains open here too: the context document is a model's reading, so hunters are told to trust the code over it and flag contradictions, but nothing independently checks recon. Hunters escalate each real defect to the strongest variant its cited lines support — severity follows cited reach, never inference — and reproduction steps must stand alone before a validator calls a candidate supported.

Pipeline: recon → hunt (sequential passes × lens) → validate → reverify → gapfill → dedup → trace → feedback → report → VVS. State lives in SQLite under the output directory; a run with the same output directory resumes.

## Install

Requirements: Node.js >= 22.19 (no build step), plus the API key for whichever provider your `scope.json` names (`MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) in the environment that starts your agent.

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

Codex uses `[mcp_servers.secgin] command = "node" args = [...]` in `~/.codex/config.toml`; VS Code uses `servers.secgin` with `"type": "stdio"`; OpenCode uses `mcp.secgin` with `"type": "local"`. The agent should see tools `harness_models`, `harness_plan`, `harness_run`, `harness_status`, `harness_evaluate`.

## Providers

`harness_models` prints the catalog with a `hasCredentials` flag per entry — never the key itself.

| provider | env key | example `{provider,id}` | note |
| --- | --- | --- | --- |
| `minimax` | `MINIMAX_API_KEY` | `minimax/MiniMax-M2.7` | also reads MiniMax Code `config.yaml` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` (or `MINIMAX_API_KEY`) | `minimax-cn/MiniMax-M3` | api.minimaxi.com |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-5` | |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` | honors `OPENAI_BASE_URL`; sends `max_completion_tokens` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/deepseek/deepseek-r1` | model ids keep their vendor prefix |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-reasoner` | |
| `google` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `google/gemini-2.5-pro` | |
| `openai-compatible` | `HARNESS_OPENAI_COMPAT_API_KEY` (optional) | `openai-compatible/qwen2.5-coder` | needs `HARNESS_OPENAI_COMPAT_BASE_URL`; models from `HARNESS_OPENAI_COMPAT_MODELS` as `id:contextWindow:maxTokens` comma list, e.g. `HARNESS_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1 HARNESS_OPENAI_COMPAT_MODELS=qwen2.5-coder:32768:8192` for Ollama. Loopback hosts need no key; remote hosts require one. |
| `agent` | `SECGIN_AGENT_DIR` | `agent/coding-agent` | file-exchange transport to a local coding agent; no API key |

`SECURITY_HARNESS_MODELS` is a JSON array of `{provider,id,contextWindow,maxTokens}` that extends or overrides catalog entries for the providers above — new model ids without a code change.

```json
{
	"models": {
		"recon": { "provider": "google", "id": "gemini-2.5-pro" },
		"hunter": { "provider": "openai", "id": "gpt-5" },
		"validator": { "provider": "anthropic", "id": "claude-sonnet-4-5" }
	}
}
```

Hunter and validator must differ; putting them on different providers is recommended so they cross-check.

## Use

Write a `scope.json` beside or above the code, then ask your agent:

> Audit ./api with secgin. Scope is ./api/scope.json, output to ../secgin-out/api.

The Skill walks the agent through `harness_models` → `harness_plan` (offline validation; names the wrong key) → `harness_run` (`confirmed=true`, output outside the source root) → `harness_status`. Ask it to re-run with the same output directory to resume. After you reproduce candidates, hand it a `labels.json` and ask for `harness_evaluate` to score the run.

### scope.json

All keys required, unknown keys rejected.

```json
{
  "version": 1,
  "name": "acme-api-review",
  "authorization": { "reference": "SOW #1234", "expiresAt": "2026-12-31T23:59:59Z", "allowRemoteModels": true },
  "root": ".",
  "files": ["src/auth/session.ts", "contracts/Vault.sol"],
  "domains": ["web2", "web3"],
  "models": {
    "recon":     { "provider": "minimax", "id": "MiniMax-M2.7-highspeed" },
    "hunter":    { "provider": "minimax", "id": "MiniMax-M3" },
    "validator": { "provider": "minimax", "id": "MiniMax-M2.7" }
  },
  "limits": { "maxCalls": 400, "maxInputChars": 1500000, "maxOutputTokens": 32000, "timeoutMs": 1800000, "concurrency": 4, "passes": 2, "maxFindingsPerTask": 10 }
}
```

- `root`/`files`: relative, no `..`, no symlinks, 1–500 text source files; `.env`, keys, `.ssh/`, `.git/` rejected.
- `domains`: any of `web2`, `web3`, `ai`.
- `models`: pairs from `harness_models`; hunter ≠ validator so validation is an independent read.
- `limits.passes`: sequential hunt passes per lens (1–3). Caps: `maxCalls` 1000, `maxInputChars` 2,000,000, `maxOutputTokens` 100,000, `timeoutMs` 3,600,000, `concurrency` 8, `maxFindingsPerTask` 20.

### Output

`report.md` / `report.json`, `architecture.md` (the intent model recon wrote), `x-ray.md`, `fizz-proposed.md` (web3, invariant properties proposed, never executed), and `findings.json` with each candidate as `needs-reproduction`, `needs-context`, `rejected`, or `unvalidated`.

## Notes

- Vendored Pashov x-ray / solidity-auditor / fizz skills are reference material mapped onto stages (`pashov/HARNESS.md`); their scripts never run.
- Vendored mdpsec prompt packs under `mdpsec/` contribute rubrics and a deterministic pre-submit gate only; their live phases, browser/account/OOB tooling, and should-i-submit live validation are never executed.
- Rules for agents editing this repository: `AGENTS.md`.

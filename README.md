# secgin

Host-agnostic vulnerability harness (VDH → VVS, after [Cloudflare's design](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)) for source you are authorized to test: Web2 services, AI/agent surfaces, Solidity contracts. Works with any coding agent that supports Agent Skills or MCP.

Models only read source and declare candidates. No target requests, exploits, tool execution, patches, or live scans. Nothing is ever marked confirmed.

## Pipeline

recon (3 passes + synthesis) → hunt (one model call per area × attack-class cell) → validate (mechanical path/line/quote checks, then an isolated model tries to disprove) → reverify → gapfill → dedup → trace → feedback → report → VVS (dedup, judgment, fix proposals). State is stored in SQLite under the output directory; re-running with the same output directory resumes.

## Requirements

- Node.js >= 22.19 (no build, no `npm install` at runtime)
- `MINIMAX_API_KEY` (or `MINIMAX_CN_API_KEY`) in the environment that starts your agent or the server
- Local source you may test, plus a `scope.json` you write

## Install

```bash
git clone https://github.com/fozagtx/secgin && cd secgin
node install-plugin.mjs --host <host>
```

| `--host` | Installs to | Notes |
| --- | --- | --- |
| `claude` | `~/.claude/plugins/secgin` | plugin + `.mcp.json`; or `claude plugin marketplace add fozagtx/secgin && claude plugin install secgin@secgin` |
| `codex` | `~/.codex/plugins/secgin` | adds to `~/.agents/plugins/marketplace.json` |
| `minimax` | `~/.minimax-code/plugins/secgin` | |
| `cloud` | `~/.secgin` | then `node ~/.secgin/server.mjs --http --port 8787` → `http://127.0.0.1:8787/mcp` |
| `dest --path DIR` | any directory | for every other agent |
| `all` | claude + codex + minimax | |

Restart the host afterwards. Re-run the same command to update; the installer only replaces an existing secgin copy, never unrelated directories.

### Any other agent

```bash
node install-plugin.mjs --host dest --path ~/.agents/secgin
```

1. Point the agent at `~/.agents/secgin/skills/secgin/SKILL.md` (rules/instructions/skills directory, or tell it to read the file before auditing).
2. Register the MCP server (stdio). Use the absolute path the installer printed:

```json
{ "mcpServers": { "secgin": { "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```

Cursor, Gemini CLI, Windsurf, Cline/Roo accept that shape. Codex: `[mcp_servers.secgin] command = "node" args = ["/abs/secgin/server.mjs"]` in `~/.codex/config.toml`. VS Code: `servers.secgin` with `"type": "stdio"`. OpenCode: `mcp.secgin` with `"type": "local", "command": ["node", "/abs/secgin/server.mjs"]`. Remote/cloud agents: run `--host cloud` on a reachable machine and register the HTTP URL (`--bind 0.0.0.0` only behind your own auth; anyone reaching the port can start runs).

Check: `printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node /abs/secgin/server.mjs` lists `harness_models`, `harness_plan`, `harness_run`, `harness_status`, `harness_evaluate`.

## scope.json

Placed beside or above the code. All keys required, unknown keys rejected. `harness_plan` validates it offline and names the wrong key.

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
- `domains`: `web2`, `web3`, `ai`, or any combination (`ai` adds six LLM/agent/MCP cells; `web3` adds twelve Solidity auditor cells + fizz invariant proposals).
- `models`: pairs from `harness_models`; hunter ≠ validator.
- `limits` caps: `maxCalls` 1000, `maxInputChars` 2,000,000 (snapshot ≤ half), `maxOutputTokens` 100,000, `timeoutMs` 3,600,000, `concurrency` 8, `passes` 3, `maxFindingsPerTask` 20.

## Run

Ask your agent: *"Audit ./api with secgin; scope ./api/scope.json, output ../secgin-out/api."* The Skill drives `harness_models` → `harness_plan` → `harness_run` (`confirmed=true`, output outside the source root) → `harness_status`.

Without an agent:

```bash
node cli.ts plan scope.json
node cli.ts run scope.json ../out --allow-remote-models [--keep-models]
node cli.ts status ../out
node cli.ts evaluate ../out/report.json labels.json   # after you reproduce candidates
```

Exit codes: 0 done, 1 config/runtime error (the reason is printed), 2 incomplete — re-run to resume.

Output: `report.json`, `report.md`, `architecture.md`, `x-ray.md`, `fizz-proposed.md` (web3), `findings.json` with status `needs-reproduction`, `needs-context`, `rejected`, or `unvalidated`.

## Notes

- Vendored [Pashov](https://github.com/pashov/skills) x-ray / solidity-auditor / fizz skills are reference material mapped to stages (`pashov/HARNESS.md`); their scripts are never executed.
- Docker: `compose.yaml` (inner sandbox needs `seccomp=unconfined`, `apparmor=unconfined`).
- Dev: `npm test`, `node scripts/mcp-smoke.mjs`. Rules for agents editing this repo: `AGENTS.md`.

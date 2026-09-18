# secgin

Host-agnostic security research plugin for AI coding agents. Point it at source you are authorized to test (Web2 apps, APIs, AI agent surfaces, or Solidity/Vyper smart contracts) and it runs a structured hunt for exploitable, impact-first vulnerabilities, then validates and reports them.

This repository **is** the plugin. It follows [Agent Plugins 1.0](https://agent-plugins.org): a **Skill** (`skills/secgin/SKILL.md`) that teaches your agent how to operate the harness, an **MCP server** (`server.mjs`) that exposes five `harness_*` tools, and a **JSON worker** (`cli.ts`) that does the actual work. Any agent that can load a Skill file or connect to an MCP server can use it: Claude Code, Codex, MiniMax Code, Cursor, Gemini CLI, OpenCode, Windsurf, VS Code Copilot, Cline, Devin, or a cloud agent talking HTTP.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
  - [Built-in host adapters](#built-in-host-adapters)
  - [Any other agent (generic)](#any-other-agent-generic)
  - [Per-host wiring snippets](#per-host-wiring-snippets)
  - [Cloud / HTTP](#cloud--http)
  - [Verify the install](#verify-the-install)
  - [Update and uninstall](#update-and-uninstall)
- [Configure a target: `scope.json`](#configure-a-target-scopejson)
- [Model credentials](#model-credentials)
- [Run an audit](#run-an-audit)
- [Output](#output)
- [Headless worker (no agent)](#headless-worker-no-agent)
- [Boundaries](#boundaries)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

```
your agent (host)  ──MCP──▶  server.mjs  ──spawn──▶  cli.ts (JSON worker)  ──HTTPS──▶  models in YOUR scope.json
       ▲                                                   │
       └── loads skills/secgin/SKILL.md                    └── writes report.json + markdown to YOUR output dir
```

- The **host** is whatever agent you already use. It never does the analysis itself; it calls MCP tools.
- The **worker** snapshots the files listed in your `scope.json`, sends them to the recon/hunter/validator models you configured, and runs a fixed pipeline: recon (x-ray) → optional fuzz-property proposals (fizz) → twelve hunter cells (one per vulnerability class) → validation → dedup/judgment → report.
- **Models cannot execute anything.** They only read source and declare findings. No shell, no tests, no exploits, no network calls to the target. Confirmed findings stay at **0** until a human reproduces one.
- Hunt compute is billed to **your** model provider keys, not to the host agent's subscription.

MCP tools exposed to the host:

| Tool | What it does | Network |
| --- | --- | --- |
| `harness_models` | List the model catalog (`{provider,id}` pairs) usable in `scope.json` | offline |
| `harness_plan` | Validate `scope.json` and print the planned work cells | offline |
| `harness_run` | Run the full pipeline. Requires `confirmed=true`, `scope`, `output` | sends scoped source to your models |
| `harness_status` | Summarize `report.json` from an output directory | offline |
| `harness_evaluate` | Score your human-reviewed `labels.json` against a report | offline |

## Requirements

- **Node.js >= 22.19** (`node --version`). The worker is TypeScript executed directly via Node's type stripping; no build step and no `npm install` needed at runtime.
- An agent that supports **Agent Skills and/or MCP** (stdio or Streamable HTTP).
- **API keys** for the model providers you name in `scope.json` (see [Model credentials](#model-credentials)).
- Source code you are **authorized** to test, on local disk.

## Install

```bash
git clone https://github.com/fozagtx/secgin
cd secgin
node install-plugin.mjs --host <host>
```

The installer copies a self-contained plugin (worker, server, Skill, vendored references) into the location your host expects, writes any host-specific manifests, and prints a generic wiring snippet you can paste into any other agent. Run it once per host you want to use, or `--host all` for MiniMax + Codex + Claude together.

### Built-in host adapters

| `--host` | Installs to | Also writes | Env override |
| --- | --- | --- | --- |
| `claude` | `~/.claude/plugins/secgin` | `.claude-plugin/plugin.json`, `.mcp.json`, local marketplace | `CLAUDE_CONFIG_DIR` |
| `codex` | `~/.codex/plugins/secgin` | entry in `~/.agents/plugins/marketplace.json` | `CODEX_HOME`, `AGENTS_PLUGINS_MARKETPLACE` |
| `minimax` | `~/.minimax-code/plugins/secgin` | – | `MINIMAX_DATA_DIR` |
| `cloud` | `~/.secgin` | prints HTTP start command | `SECGIN_HOME` |
| `dest` | `--path DIR` (any directory you choose) | – | – |
| `all` | claude + codex + minimax | all of the above | all of the above |

Restart the host after installing so it picks up the new Skill and MCP server.

Claude Code can alternatively install straight from GitHub through its plugin marketplace:

```bash
claude plugin marketplace add fozagtx/secgin
claude plugin install secgin@secgin
```

### Any other agent (generic)

Every agent that speaks MCP can use secgin. Copy the plugin somewhere stable and wire two things:

```bash
node install-plugin.mjs --host dest --path ~/.agents/secgin
```

1. **Skill** – make your agent read `~/.agents/secgin/skills/secgin/SKILL.md`. Depending on the host this is a "skills"/"rules"/"instructions" directory, a `@file` mention, or simply telling the agent *"read ~/.agents/secgin/skills/secgin/SKILL.md before auditing"*. The Skill tells the agent which tool to call, in which order, and what it must never do.
2. **MCP server (stdio)** – register this server definition (use the absolute path the installer printed):

```json
{
  "mcpServers": {
    "secgin": {
      "command": "node",
      "args": ["/home/you/.agents/secgin/server.mjs"]
    }
  }
}
```

If your host only supports HTTP MCP, see [Cloud / HTTP](#cloud--http).

### Per-host wiring snippets

Replace `/abs/secgin` with the absolute path the installer printed. Config file locations follow each vendor's current documentation; check their docs if a path has moved.

<details>
<summary><b>Claude Code</b></summary>

`--host claude` already registers the plugin. To register only the MCP server instead:

```bash
claude mcp add secgin -- node /abs/secgin/server.mjs
```
</details>

<details>
<summary><b>Codex CLI</b></summary>

`--host codex` copies the plugin and adds it to your personal marketplace (`~/.agents/plugins/marketplace.json`). To register only the MCP server, add to `~/.codex/config.toml`:

```toml
[mcp_servers.secgin]
command = "node"
args = ["/abs/secgin/server.mjs"]
```
</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{ "mcpServers": { "secgin": { "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```

Add `/abs/secgin/skills/secgin/SKILL.md` as a project rule or reference it with `@` in chat.
</details>

<details>
<summary><b>Gemini CLI</b></summary>

`~/.gemini/settings.json`:

```json
{ "mcpServers": { "secgin": { "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```
</details>

<details>
<summary><b>OpenCode</b></summary>

`opencode.json`:

```json
{ "mcp": { "secgin": { "type": "local", "command": ["node", "/abs/secgin/server.mjs"], "enabled": true } } }
```
</details>

<details>
<summary><b>Windsurf</b></summary>

`~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "secgin": { "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```
</details>

<details>
<summary><b>VS Code (GitHub Copilot agent mode)</b></summary>

`.vscode/mcp.json`:

```json
{ "servers": { "secgin": { "type": "stdio", "command": "node", "args": ["/abs/secgin/server.mjs"] } } }
```
</details>

<details>
<summary><b>Cline / Roo Code</b></summary>

Open the MCP Servers panel → *Configure MCP Servers* and add the same `mcpServers.secgin` stdio entry shown in the generic section.
</details>

<details>
<summary><b>Devin and other cloud agents</b></summary>

Cloud agents cannot spawn a local stdio process. Run the HTTP server on a machine the agent can reach (see below) and register `http://HOST:8787/mcp` as a remote MCP server. Add the Skill file contents to the agent's knowledge/instructions.
</details>

### Cloud / HTTP

```bash
node install-plugin.mjs --host cloud          # copies to ~/.secgin
node ~/.secgin/server.mjs --http --port 8787  # Streamable HTTP MCP
# MCP URL: http://127.0.0.1:8787/mcp
```

The server binds to `127.0.0.1` by default. `--bind 0.0.0.0` exposes it to the network; only do that behind your own authentication or a private network, because anyone who can reach the port can start runs that read source from that machine and spend your model credits.

### Verify the install

```bash
# list the five harness tools over stdio
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node /abs/secgin/server.mjs
# offline model catalog
node /abs/secgin/cli.ts models
```

Then, inside your agent, ask: *"list the secgin harness models"*. It should call `harness_models` and return `minimax` / `minimax-cn` entries.

### Update and uninstall

Update: `git pull` in this repo and re-run the same `install-plugin.mjs` command. The installer replaces a previous secgin copy in place. It refuses to delete a non-empty directory that is not a secgin install, so a wrong `--path` cannot wipe unrelated files.

Uninstall: delete the install directory from the table above and remove the `secgin` entry from your host's MCP/marketplace config.

## Configure a target: `scope.json`

Every run is driven by a `scope.json` **you** write, placed next to (or above) the code it describes. There is no example target and no demo mode. All keys below are required; unknown keys are rejected.

```json
{
  "version": 1,
  "name": "acme-api-q3-review",
  "authorization": {
    "reference": "Pentest SOW #1234 signed 2026-09-01",
    "expiresAt": "2026-12-31T23:59:59Z",
    "allowRemoteModels": true
  },
  "root": ".",
  "files": [
    "src/auth/session.ts",
    "src/api/payments.ts",
    "contracts/Vault.sol"
  ],
  "domains": ["web2", "web3"],
  "models": {
    "recon":     { "provider": "minimax", "id": "MiniMax-M2.7-highspeed" },
    "hunter":    { "provider": "minimax", "id": "MiniMax-M3" },
    "validator": { "provider": "minimax", "id": "MiniMax-M2.7" }
  },
  "limits": {
    "maxCalls": 400,
    "maxInputChars": 1500000,
    "maxOutputTokens": 32000,
    "timeoutMs": 1800000,
    "concurrency": 4,
    "passes": 2,
    "maxFindingsPerTask": 10
  }
}
```

| Key | Rules |
| --- | --- |
| `version` | Must be `1`. |
| `name` | Free text, <= 200 chars. Used in report headers. |
| `authorization.reference` | Who authorized this test (engagement ID, bug-bounty program URL, "my own repo"). Recorded in the report. |
| `authorization.expiresAt` | ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`). Runs refuse to start after it. |
| `authorization.allowRemoteModels` | Must be `true` to send source to remote models. `false` lets you `plan` but not `run`. |
| `root` | Directory containing the files, relative to `scope.json`. `"."` for the same directory. No `..`, no absolute paths, no symlinks. |
| `files` | 1–500 relative paths (no globs; expand them yourself, e.g. `git ls-files 'src/**/*.ts'`). Only text source extensions are accepted (`.ts .js .py .go .rs .java .c .cpp .cs .rb .php .sol .vy .yul .json .yaml .toml .md`, etc.). Secrets (`.env`, `*.pem`, `*.key`, `credentials*`, `.ssh/`, `.git/`) are rejected. |
| `domains` | `["web2"]`, `["web3"]`, or both. `web3` adds the twelve `hunt:web3:*` Solidity auditor cells and fizz proposals. |
| `models.recon` / `hunter` / `validator` | `{provider,id}` pairs from `harness_models`. **Hunter and validator must differ.** |
| `limits.*` | Positive integers, hard caps in parentheses: `maxCalls` (1000), `maxInputChars` (2,000,000; the snapshot may use at most half), `maxOutputTokens` (100,000; must not exceed the model's max), `timeoutMs` (3,600,000), `concurrency` (8), `passes` (3), `maxFindingsPerTask` (20). |

Run `harness_plan` (or `node cli.ts plan scope.json`) after editing; it validates everything offline and tells you exactly which key is wrong.

## Model credentials

The worker ships a MiniMax client (Anthropic-compatible API). Catalog providers:

| `provider` | Endpoint | Key lookup order |
| --- | --- | --- |
| `minimax` | `api.minimax.io` | `MINIMAX_API_KEY` env → `apiKey:` in `$MINIMAX_DATA_DIR/config.yaml`, `~/.minimax-code/config.yaml`, `~/.minimax/config.yaml` |
| `minimax-cn` | `api.minimaxi.com` | `MINIMAX_CN_API_KEY` → `MINIMAX_API_KEY` → same config files |

Model IDs: `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M3` (run `harness_models` for the live list with context windows). Export the key in the environment that launches your agent (the MCP server inherits it) or, for the HTTP server, in the shell that starts `server.mjs`.

## Run an audit

With the plugin installed, tell your agent something like:

> Audit ./services/payments with secgin. Scope is ./services/payments/scope.json, write output to ../secgin-out/payments.

The Skill makes the agent:

1. Read `skills/secgin/SKILL.md`.
2. Call `harness_models` and confirm your `scope.json` uses three catalog models (hunter ≠ validator).
3. Call `harness_plan` with your `scope.json` and fix any validation error.
4. Call `harness_run` with `confirmed=true`, your scope, and an **output directory outside the source root**.
5. Call `harness_status` and walk you through the candidates.

Re-running `harness_run` with the same scope and output directory **resumes** an interrupted run. If you change the scope, source, or prompts, use a new output directory.

## Output

The output directory contains:

| File | Contents |
| --- | --- |
| `report.json` | Full machine-readable report (recon, every hunt cell, validation verdicts, dedup) |
| `report.md` | Human-readable summary |
| `architecture.md` | Recon/x-ray architecture summary of the target |
| `x-ray.md` | Attack-surface map |
| `fizz-proposed.md` | Proposed fuzz invariants (web3 only; proposals, never executed) |
| `findings.json` / `FINDINGS-DETAIL.md` | Candidate findings with status `needs-reproduction`, `needs-context`, `rejected`, or `unvalidated` |

Nothing is ever marked confirmed by the tool. Reproduce a candidate yourself, then optionally record your verdicts in a `labels.json` and run `harness_evaluate` to score precision against the report.

## Headless worker (no agent)

The same backbone runs from a terminal with no TUI or MCP:

```bash
node cli.ts models                                   # offline catalog
node cli.ts plan /path/to/scope.json                 # offline validation + plan
node cli.ts run  /path/to/scope.json /path/to/private-output --allow-remote-models
node cli.ts status /path/to/private-output
node cli.ts evaluate /path/to/private-output/report.json /path/to/labels.json
```

`run` prompts before each stage unless you add `--keep-models`. Exit codes: `0` completed, `1` configuration/runtime error, `2` incomplete pipeline (re-run to resume).

Inside Docker, use the provided `compose.yaml`; the inner sandbox needs `seccomp=unconfined` and `apparmor=unconfined`.

## Boundaries

- Models read source and declare findings. They cannot execute tools, shell, patches, tests, exploits, or live scans.
- No requests are ever made to the target system. Only the model provider is contacted.
- Output must live **outside** the source root; the worker never writes into the audited tree.
- The vendored [Pashov Audit Group](https://github.com/pashov/skills) skills under `pashov/` (x-ray, solidity-auditor, fizz) are used as **reference material mapped to harness stages**. Their scripts (`enumerate.sh`, Foundry coverage, Echidna, Medusa) are never executed. See `pashov/HARNESS.md`.
- No canned target, demo finding, or mock client exists in this repo.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Agent does not see `harness_*` tools | Restart the host. Check the MCP config points to an **absolute** `server.mjs` path. Test with the `tools/list` one-liner in [Verify the install](#verify-the-install). |
| `Invalid secgin configuration: ...` | The message names the exact key. Compare with the table in [Configure a target](#configure-a-target-scopejson). |
| `A configured model provider has no credentials` | Export `MINIMAX_API_KEY` (or the CN variant) in the environment that launches the agent/server. |
| `Configured model is absent from the installed catalog` | Run `harness_models` and copy an exact `{provider,id}` pair. |
| `config.authorization.expiresAt has expired` | Extend the date in `scope.json`; runs never start on an expired authorization. |
| `Unsafe snapshot file` | The path is outside `root`, a symlink, a secret file, or has an unsupported extension. |
| `Snapshot exceeds half of maxInputChars` | Raise `limits.maxInputChars` (cap 2,000,000) or list fewer files. |
| `Refusing to overwrite non-empty directory` | The `--path` you gave already holds unrelated files. Pick an empty or previously-installed directory. |
| `SyntaxError` running `cli.ts` | Node is older than 22.19. Upgrade; the worker relies on native TypeScript stripping. |
| Tests fail on macOS with temp-dir errors | `TMPDIR=/private/tmp npm test`. |

## Development

```bash
npm test                 # 70+ node:test cases, offline
node scripts/mcp-smoke.mjs   # tools/list over stdio against an installed copy
```

CI runs the test suite plus a cloud install and MCP smoke test on every push and PR (`.github/workflows`). See `AGENTS.md` for the rules agents must follow when working in this repo.

License: MIT (`LICENSE`). Vendored Pashov skills keep their own MIT license in `pashov/LICENSE`.

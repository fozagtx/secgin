# secgin

This repository **is** the plugin. [Agent Plugins 1.0](https://agent-plugins.org): Skill + MCP, plus a JSON worker backbone.

The worker does not care which CLI, TUI, or cloud agent spawned it. Swap the host whenever you want. Hunt models come from **your** `scope.json` `{provider,id}` pairs, not from the host app. Worker models are impact-first bug-bounty hunters (Web2 or smart contract). Confirmed stays 0 until you reproduce. No canned target.

## Install

Clone this repo, then copy it into whichever host you are using:

```bash
git clone https://github.com/fozagtx/secgin
cd secgin
node install-plugin.mjs --host <host>
```

`--host` is required. Built-in adapters:

| `--host` | Where it goes |
| --- | --- |
| `minimax` | MiniMax Code plugin dir |
| `codex` | Codex plugin dir + personal marketplace |
| `claude` | Claude Code plugin dir + marketplace |
| `cloud` | `~/.secgin` + loopback Streamable HTTP |
| `dest` | `--path /your/dir` — generic copy for any other CLI |
| `all` | minimax + codex + claude |

Any other agent that loads Agent Plugins or MCP can use `--host dest --path …` and point at `server.mjs` (stdio) or `node server.mjs --http`.

```bash
node install-plugin.mjs --host dest --path ~/agents/secgin
node install-plugin.mjs --host cloud
# then: node ~/.secgin/server.mjs --http --port 8787
# MCP URL: http://127.0.0.1:8787/mcp
```

Claude marketplace (optional):

```bash
claude plugin marketplace add fozagtx/secgin
```

Restart the host after install. MCP tools: `harness_models`, `harness_plan`, `harness_run` (`confirmed=true`), `harness_status`, `harness_evaluate`.

## Headless worker

Same backbone with no TUI:

```bash
node cli.ts models
node cli.ts plan /path/to/your/scope.json
node cli.ts run /path/to/your/scope.json /path/to/private-output --allow-remote-models
node cli.ts status /path/to/private-output
```

Output must be **outside** the source root. Set provider keys for whatever is in `scope.json`. No demo target.

```bash
npm test
```

On macOS use `TMPDIR=/private/tmp npm test`.

## Boundaries

Models cannot execute tools, shell, patches, tests, exploits, or live scans. Vendored Pashov skills under `pashov/` are mapped, never executed as playbooks.

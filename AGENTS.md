# Development Rules

Keep answers short. No emojis in commits. Technical prose only.

When the operator asks to audit, x-ray, fizz, hunt, validate, or review **their** source:

1. Immediately `read` [`skills/secgin/SKILL.md`](skills/secgin/SKILL.md).
2. If they named x-ray, solidity-auditor, fizz, pashov, mdpsec, should-i-submit, or bug-bounty-hunting-prompts, also `read` [`pashov/HARNESS.md`](pashov/HARNESS.md) and [`mdpsec/HARNESS.md`](mdpsec/HARNESS.md).
3. Use MCP tools `harness_models`, `harness_plan`, `harness_run` (`confirmed=true`), `harness_status`, and `harness_evaluate`.
4. Do **not** execute `pashov/**/SKILL.md` as a playbook. No `enumerate.sh`, forge/hardhat coverage, Echidna, Medusa, or `test/fizz` writes into the target. Do **not** execute `mdpsec/**` phase files or should-i-submit's live validation mode either.
5. No canned target, demo finding, mock client, live scan, exploit execution, or model-confirmed bugs. Confirmed stays 0 until a human reproduces.
6. Drost (https://github.com/drost-ai/drost-community) is an optional, separate MCP server the operator registers for their own reproduction. secgin tools and the worker never call it. Use `drost_*` tools only when the operator explicitly asks to reproduce a named candidate against a local or isolated target they own or are authorized to test, following the "Reproducing with Drost" section of the Skill. Never mark the result confirmed.

7. Supermemory (https://supermemory.ai/) is an optional, separate MCP server for host-agent long-term memory. secgin tools and the worker never call it. Follow the "Long-term memory with Supermemory" section of the Skill. Append generalized lessons to `skills/secgin/LESSONS.md` only when the operator asks.

When editing this repository:

- secgin is agent-first. The operator talks to their agent; the agent calls MCP tools. `cli.ts` is the worker `server.mjs` spawns, not a user-facing CLI. Do not document shell invocations of it as a way to use secgin.
- Do not add tests, fixtures, or scripts that are not required by a change. Do not add files that do not belong to the plugin package.
- Prompt changes bump `PROMPT_VERSION` in `prompts.ts`.

Install from this repository into the host you are using: `node install-plugin.mjs --host minimax|codex|claude|gemini|cloud|dest|all`.

# Development Rules

Keep answers short. No emojis in commits. Technical prose only.

When the operator asks to audit, x-ray, fizz, hunt, validate, or review **their** source:

1. Immediately `read` [`skills/secgin/SKILL.md`](skills/secgin/SKILL.md).
2. If they named x-ray, solidity-auditor, fizz, pashov, mdpsec, should-i-submit, or bug-bounty-hunting-prompts, also `read` [`pashov/HARNESS.md`](pashov/HARNESS.md) and [`mdpsec/HARNESS.md`](mdpsec/HARNESS.md).
3. Use MCP tools `harness_plan`, `harness_run` (`confirmed=true`), `harness_next`, `harness_submit`, `harness_status`, and `harness_evaluate`. secgin calls no provider and holds no API key: `harness_run`/`harness_next` return prompts for the driving agent, which answers them with `harness_submit`. Keep hunting and validation on separate reads.
4. Do **not** execute `pashov/**/SKILL.md` as a playbook. No `enumerate.sh`, forge/hardhat coverage, Echidna, Medusa, or `test/fizz` writes into the target. Do **not** execute `mdpsec/**` phase files or should-i-submit's live validation mode either.
5. No canned target, demo finding, mock client, live scan, exploit execution, or model-confirmed bugs. Confirmed stays 0 until a human reproduces.
6. Drost (https://github.com/drost-ai/drost-community) is an optional, separate MCP server the operator registers for their own reproduction. secgin tools never call it. Use `drost_*` tools only when the operator explicitly asks to reproduce a named candidate against a local or isolated target they own or are authorized to test, following the "Reproducing with Drost" section of the Skill. Never mark the result confirmed.

When editing this repository:

- secgin is agent-first. The operator talks to their agent; the agent calls MCP tools. The VDH/VVS pipeline runs in-process in `server.mjs`: `runHarness` (in `runner.ts`) drives it with a `CallbackClient` (`callback-client.ts`) that parks each prompt for the agent instead of calling a model. secgin ships no CLI and no provider/model client. Do not reintroduce API keys, a model catalog, or a user-facing shell entrypoint.
- Do not add tests, fixtures, or scripts that are not required by a change. Do not add files that do not belong to the plugin package.
- Prompt changes bump `PROMPT_VERSION` in `prompts.ts`.

Install from this repository into the host you are using: `node install-plugin.mjs --host minimax|codex|claude|gemini|cloud|dest|all`.

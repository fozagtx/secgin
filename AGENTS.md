# Development Rules

Keep answers short. No emojis in commits. Technical prose only.

When the operator asks to audit, x-ray, fizz, hunt, validate, or review **their** source:

1. Immediately `read` [`skills/secgin/SKILL.md`](skills/secgin/SKILL.md).
2. If they named x-ray, solidity-auditor, fizz, or pashov, also `read` [`pashov/HARNESS.md`](pashov/HARNESS.md).
3. Use MCP tools `harness_models`, `harness_plan`, `harness_run` (`confirmed=true`), `harness_status`, and `harness_evaluate`.
4. Do **not** execute `pashov/**/SKILL.md` as a playbook. No `enumerate.sh`, forge/hardhat coverage, Echidna, Medusa, or `test/fizz` writes into the target.
5. No canned target, demo finding, mock client, live scan, exploit execution, or model-confirmed bugs. Confirmed stays 0 until a human reproduces.

Install from this repository into the host CLI you are using: `node install-plugin.mjs --host minimax|codex|claude|cloud|dest|all`.

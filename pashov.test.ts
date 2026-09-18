import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LENSES } from "./prompts.ts";
import {
	loadInstalledPashov,
	PASHOV_ORIGIN,
	pashovSlashPreview,
	pashovVendorRoot,
	SOLIDITY_AUDITOR_LENS_IDS,
} from "./pashov.ts";
import { plan } from "./runner.ts";

const repoRoot = dirname(fileURLToPath(import.meta.url));

test("pashov/skills is installed from GitHub with x-ray, solidity-auditor, and fizz", () => {
	const install = loadInstalledPashov();
	assert.equal(install.origin, PASHOV_ORIGIN);
	assert.match(install.commit, /^[0-9a-f]{40}$/);
	assert.deepEqual(
		install.skills.map((skill) => skill.name),
		["x-ray", "solidity-auditor", "fizz"],
	);
	assert.equal(SOLIDITY_AUDITOR_LENS_IDS.length, 12);
	assert.deepEqual(Object.keys(LENSES.web3), SOLIDITY_AUDITOR_LENS_IDS);
	for (const skill of install.skills) {
		assert.equal(existsSync(skill.skillMd), true);
		assert.equal(existsSync(join(pashovVendorRoot(), skill.name, "VERSION")), true);
	}
	assert.equal(existsSync(join(pashovVendorRoot(), "LICENSE")), true);
	assert.match(pashovSlashPreview("x-ray", install), /github.com\/pashov\/skills/);
	assert.match(pashovSlashPreview("fizz", install), /never writes test\/fizz/);
});

test("plugin skill forbids executing vendored Pashov playbooks", () => {
	const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
	const skill = readFileSync(join(repoRoot, "skills/secgin/SKILL.md"), "utf8");
	assert.match(agents, /skills\/secgin\/SKILL\.md/);
	assert.match(agents, /Do \*\*not\*\* execute `pashov\/\*\*\/SKILL\.md`/);
	assert.match(skill, /Do not execute vendored Pashov playbooks/);
	assert.match(skill, /the host agent/);
	assert.equal(existsSync(join(repoRoot, "plugin.json")), true);
	assert.equal(existsSync(join(repoRoot, "skills", "secgin", "SKILL.md")), true);
	assert.doesNotMatch(readFileSync(join(repoRoot, "install-plugin.mjs"), "utf8"), /cursor/);
});

test("web3 plan is the twelve solidity-auditor agents plus web2 cells", () => {
	const hunts = plan({
		version: 1,
		name: "pashov-plan",
		authorization: { reference: "test", expiresAt: "2099-01-01T00:00:00Z", allowRemoteModels: false },
		root: ".",
		files: ["x.ts"],
		domains: ["web2", "web3"],
		models: {
			recon: { provider: "t", id: "r" },
			hunter: { provider: "t", id: "h" },
			validator: { provider: "t", id: "v" },
		},
		limits: {
			maxCalls: 80,
			maxInputChars: 1000,
			maxOutputTokens: 100,
			timeoutMs: 1,
			concurrency: 1,
			passes: 1,
			maxFindingsPerTask: 1,
		},
	});
	assert.equal(hunts.length, 18);
	assert.ok(hunts.some((hunt) => hunt.id === "hunt:web3:math-precision:0"));
	assert.ok(hunts.some((hunt) => hunt.id === "hunt:web3:flow-gap:0"));
	assert.equal(
		hunts.filter((hunt) => hunt.id.startsWith("hunt:web3:")).length,
		12,
	);
});

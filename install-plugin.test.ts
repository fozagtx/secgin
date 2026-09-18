import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("./install-plugin.mjs", import.meta.url));

function collectLines(child, count, timeoutMs = 15000) {
	return new Promise((resolvePromise, reject) => {
		const lines = [];
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} MCP lines`)), timeoutMs);
		const onData = (chunk) => {
			for (const line of chunk.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				lines.push(JSON.parse(line));
				if (lines.length >= count) {
					clearTimeout(timer);
					child.stdout.off("data", onData);
					resolvePromise(lines);
				}
			}
		};
		child.stdout.on("data", onData);
	});
}

function install(env, args = []) {
	return spawnSync(process.execPath, [installer, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

async function assertStdioTools(root) {
	const child = spawn(process.execPath, [join(root, "server.mjs")], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
		const [listed] = await collectLines(child, 1);
		const names = listed.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, [
			"harness_models",
			"harness_plan",
			"harness_run",
			"harness_status",
			"harness_evaluate",
		]);
	} finally {
		child.kill("SIGTERM");
	}
}

test("install-plugin copies a self-contained plugin for the installed mcode data dir", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "mcode-plugin-"));
	try {
		const result = install({ MINIMAX_DATA_DIR: dataDir }, ["--host", "minimax"]);
		assert.equal(result.status, 0, result.stderr);
		const root = join(dataDir, "plugins", "secgin");
		assert.equal(existsSync(join(root, "plugin.json")), true);
		assert.equal(existsSync(join(root, "mcp.json")), true);
		assert.equal(existsSync(join(root, "server.mjs")), true);
		assert.equal(existsSync(join(root, "cli.ts")), true);
		assert.equal(existsSync(join(root, "minimax-client.ts")), true);
		assert.equal(existsSync(join(root, "skills", "secgin", "SKILL.md")), true);
		assert.equal(existsSync(join(root, "pi-client.ts")), false);
		assert.equal(existsSync(join(root, "extension.ts")), false);
		assert.match(readFileSync(join(root, "plugin.json"), "utf8"), /agent-plugins.org\/schemas\/1.0.0\/plugin.schema.json/);
		await assertStdioTools(root);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("install-plugin --host codex writes Agent Plugins package and a personal marketplace entry", () => {
	const home = mkdtempSync(join(tmpdir(), "codex-plugin-"));
	try {
		const result = install({ HOME: home }, ["--host", "codex"]);
		assert.equal(result.status, 0, result.stderr);
		const root = join(home, ".codex", "plugins", "secgin");
		assert.equal(existsSync(join(root, "plugin.json")), true);
		assert.equal(existsSync(join(root, "cli.ts")), true);
		const marketplace = JSON.parse(readFileSync(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
		assert.equal(marketplace.plugins[0].name, "secgin");
		assert.equal(marketplace.plugins[0].source.path, "./.codex/plugins/secgin");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("install-plugin --host claude writes a Claude plugin overlay", () => {
	const home = mkdtempSync(join(tmpdir(), "claude-plugin-"));
	try {
		const result = install({ HOME: home }, ["--host", "claude"]);
		assert.equal(result.status, 0, result.stderr);
		const root = join(home, ".claude", "plugins", "secgin");
		assert.equal(existsSync(join(root, ".claude-plugin", "plugin.json")), true);
		assert.equal(existsSync(join(root, ".mcp.json")), true);
		assert.equal(existsSync(join(root, "skills", "secgin", "SKILL.md")), true);
		const marketplace = JSON.parse(readFileSync(join(home, ".claude", "plugins", "marketplace.json"), "utf8"));
		assert.equal(marketplace.plugins[0].source, "./secgin");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("install-plugin --host cloud copies the worker and prints a loopback HTTP command", () => {
	const home = mkdtempSync(join(tmpdir(), "cloud-plugin-"));
	try {
		const result = install({ HOME: home }, ["--host", "cloud"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(home, ".secgin", "cli.ts")), true);
		assert.match(result.stdout, /--http --port 8787/);
		assert.match(result.stdout, /http:\/\/127\.0\.0\.1:8787\/mcp/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("install-plugin requires --host", () => {
	const result = install({});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--host is required/);
});

test("install-plugin --host dest copies into the operator path", () => {
	const dest = mkdtempSync(join(tmpdir(), "dest-plugin-"));
	try {
		const result = install({}, ["--host", "dest", "--path", dest]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(dest, "plugin.json")), true);
		assert.equal(existsSync(join(dest, "server.mjs")), true);
		assert.equal(existsSync(join(dest, "cli.ts")), true);
	} finally {
		rmSync(dest, { recursive: true, force: true });
	}
});

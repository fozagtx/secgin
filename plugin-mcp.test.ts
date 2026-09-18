import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

function rpc(child, id, method, params) {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

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

function waitListening(child) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout waiting for HTTP listen")), 15000);
		const onData = (chunk) => {
			const match = /security-harness mcp (http:\/\/\S+)/.exec(chunk.toString("utf8"));
			if (!match) return;
			clearTimeout(timer);
			child.stderr.off("data", onData);
			resolvePromise(match[1]);
		};
		child.stderr.on("data", onData);
	});
}

test("plugin MCP lists harness tools and lists MiniMax models over stdio", async () => {
	const child = spawn(process.execPath, [server], {
		cwd: repoRoot,
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		rpc(child, 1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		rpc(child, 2, "tools/list", {});
		rpc(child, 3, "tools/call", { name: "harness_run", arguments: { scope: "scope.json", output: "out" } });
		rpc(child, 4, "tools/call", { name: "harness_models", arguments: {} });
		const [init, listed, denied, models] = await collectLines(child, 4);
		assert.equal(init.result.serverInfo.name, "security-harness");
		const names = listed.result.tools.map((tool) => tool.name);
		assert.deepEqual(names, ["harness_models", "harness_plan", "harness_run", "harness_status", "harness_evaluate"]);
		assert.equal(denied.result.isError, true);
		assert.match(denied.result.content[0].text, /confirmed=true/);
		assert.notEqual(models.result.isError, true);
		const catalog = JSON.parse(models.result.content[0].text);
		assert.ok(catalog.some((entry) => entry.provider === "minimax" && entry.id === "MiniMax-M2.7"));
		assert.ok(!catalog.some((entry) => entry.provider === "openai"));
	} finally {
		child.kill("SIGTERM");
	}
});

test("plugin MCP serves the same tools over loopback Streamable HTTP", async () => {
	const child = spawn(process.execPath, [server, "--http", "--port", "0", "--bind", "127.0.0.1"], {
		cwd: repoRoot,
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		const endpoint = await waitListening(child);
		const listed = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		assert.equal(listed.status, 200);
		const body = await listed.json();
		assert.deepEqual(
			body.result.tools.map((tool) => tool.name),
			["harness_models", "harness_plan", "harness_run", "harness_status", "harness_evaluate"],
		);
		const denied = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "harness_run", arguments: { scope: "scope.json", output: "out" } },
			}),
		});
		const deniedBody = await denied.json();
		assert.equal(deniedBody.result.isError, true);
		assert.match(deniedBody.result.content[0].text, /confirmed=true/);
	} finally {
		child.kill("SIGTERM");
	}
});

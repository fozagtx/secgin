import assert from "node:assert/strict";
import { test } from "node:test";
import { MiniMaxClient } from "./minimax-client.ts";
import type { ModelRequest } from "./runner.ts";
import { parseConfig } from "./scope.ts";

function setup() {
	const hunter = { provider: "minimax", id: "MiniMax-M2.7" };
	const validator = { provider: "minimax", id: "MiniMax-M3" };
	const config = parseConfig({
		version: 1,
		name: "adapter-contract",
		authorization: { reference: "test", expiresAt: "2099-01-01T00:00:00Z", allowRemoteModels: true },
		root: ".",
		files: ["app.ts"],
		domains: ["web2"],
		models: { recon: hunter, hunter, validator },
		limits: {
			maxCalls: 10,
			maxInputChars: 20000,
			maxOutputTokens: 4096,
			timeoutMs: 1000,
			concurrency: 1,
			passes: 1,
			maxFindingsPerTask: 3,
		},
	});
	const request: ModelRequest = {
		model: config.models.hunter,
		system: "Read-only test",
		prompt: "Return JSON",
		maxOutputTokens: 4096,
		signal: new AbortController().signal,
	};
	return { config, request };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("MiniMax adapter requires authorization, then completes without tools", async () => {
	const { config, request } = setup();
	const calls: unknown[] = [];
	const client = new MiniMaxClient({
		env: { MINIMAX_API_KEY: "mm-test" },
		fetch: async (input, init) => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			return jsonResponse({
				stop_reason: "end_turn",
				content: [{ type: "text", text: '{"ok":true}' }],
				usage: { input_tokens: 3, output_tokens: 2 },
			});
		},
	});
	await assert.rejects(client.complete(request), /preflight/);
	await client.preflight(config);
	assert.equal((await client.complete(request)).text, '{"ok":true}');
	assert.equal(calls.length, 1);
	const call = calls[0] as { url: string; body: { model: string; max_tokens: number; messages: unknown } };
	assert.equal(call.url, "https://api.minimax.io/anthropic/v1/messages");
	assert.equal(call.body.model, "MiniMax-M2.7");
	assert.equal(call.body.max_tokens, 4096);
	config.authorization.allowRemoteModels = false;
	await assert.rejects(client.preflight(config), /not authorized/);
	await assert.rejects(client.complete(request), /preflight/);
});

test("MiniMax adapter rejects truncated, errored and tool-bearing responses", async () => {
	const { config, request } = setup();
	const payloads = [
		{ stop_reason: "max_tokens", content: [{ type: "text", text: "{}" }] },
		{ type: "error", stop_reason: "end_turn", content: [{ type: "text", text: "provider-secret" }] },
		{ stop_reason: "end_turn", content: [{ type: "tool_use", name: "bash", input: { command: "no" } }] },
	];
	for (const payload of payloads) {
		const client = new MiniMaxClient({
			env: { MINIMAX_API_KEY: "mm-test" },
			fetch: async () => jsonResponse(payload),
		});
		await client.preflight(config);
		await assert.rejects(client.complete(request), /Incomplete/);
	}
});

test("MiniMax adapter refuses oversized context before dispatch", async () => {
	const { config, request } = setup();
	let calls = 0;
	const client = new MiniMaxClient({
		env: { MINIMAX_API_KEY: "mm-test" },
		fetch: async () => {
			calls += 1;
			return jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
		},
	});
	await client.preflight(config);
	await assert.rejects(client.complete({ ...request, prompt: "x".repeat(200000) }), /context budget/);
	assert.equal(calls, 0);
});

test("adapter accepts MiniMax API keys from env or config.yaml, not OpenAI keys", async () => {
	const { config } = setup();
	const withoutLogin = new MiniMaxClient({ env: {}, readFile: () => undefined });
	await assert.rejects(withoutLogin.preflight(config), /no credentials/);
	const openaiOnly = new MiniMaxClient({ env: { OPENAI_API_KEY: "sk-test" }, readFile: () => undefined });
	await assert.rejects(openaiOnly.preflight(config), /no credentials/);
	const withEnv = new MiniMaxClient({ env: { MINIMAX_API_KEY: "mm-test" }, readFile: () => undefined });
	await withEnv.preflight(config);
	const withFile = new MiniMaxClient({
		env: {},
		homedir: "/tmp/harness-home",
		readFile: (path) =>
			path.endsWith("/.minimax-code/config.yaml")
				? "minimax_api:\n  apiKey: mm-from-file\n  baseURL: https://api.minimax.io/anthropic\n"
				: undefined,
	});
	await withFile.preflight(config);
	const listed = withEnv.listModels();
	assert.ok(listed.some((entry) => entry.provider === "minimax" && entry.id === "MiniMax-M2.7"));
	assert.ok(listed.some((entry) => entry.provider === "minimax-cn" && entry.id === "MiniMax-M3"));
	assert.ok(!listed.some((entry) => entry.provider === "openai"));
});

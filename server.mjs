import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { CallbackClient } from "./callback-client.ts";
import { evaluate } from "./evaluate.ts";
import { loadInstalledMdpsec } from "./mdpsec.ts";
import { inspectNestedRuntime, nestedRuntimeWarning } from "./nested-runtime.ts";
import { loadInstalledPashov } from "./pashov.ts";
import { LENSES } from "./prompts.ts";
import { writeReports } from "./report.ts";
import { plan, runHarness, runIdentity } from "./runner.ts";
import { loadSnapshot, parseConfig } from "./scope.ts";
import { readRunStatus } from "./status.ts";
import { RunStore } from "./store.ts";
import { HARNESS_TOOLS } from "./tools.ts";

const FINAL_MARKER = "FINAL_REPORT_AUTHORIZED";

const TOOLS = [
	{
		name: "harness_plan",
		description:
			"Validate YOUR scope.json offline and print the planned VDH/VVS waves. No model calls, no source transmitted, no canned target.",
		inputSchema: {
			type: "object",
			properties: { scope: { type: "string", description: "Path to the operator's scope.json" } },
			required: ["scope"],
			additionalProperties: false,
		},
	},
	{
		name: "harness_run",
		description:
			"Start (or resume) a run against the operator's scope. Requires confirmed=true. secgin calls no model: it returns prompts for YOU, the driving agent, to reason about, then you answer them with harness_submit. Resumes instantly from saved state when called again with the same output.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", description: "Path to the operator's scope.json" },
				output: { type: "string", description: "Output directory outside the source root" },
				confirmed: {
					type: "boolean",
					description: "Must be true. Attests you are authorized to analyze this scoped source.",
				},
			},
			required: ["scope", "output", "confirmed"],
			additionalProperties: false,
		},
	},
	{
		name: "harness_next",
		description:
			"Return the current batch of prompts the pipeline is waiting on, or report completion. Operates on the active run started by harness_run.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "harness_submit",
		description:
			"Hand your answers back to the pipeline and receive the next batch. Each answer is the exact JSON object the matching prompt asked for. You may fan the prompts out to parallel sub-agents, but recon, hunting and validation should be independent reads.",
		inputSchema: {
			type: "object",
			properties: {
				answers: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "The id of the prompt you are answering" },
							text: { type: "string", description: "Your response: the JSON object the prompt specified" },
						},
						required: ["id", "text"],
						additionalProperties: false,
					},
				},
			},
			required: ["answers"],
			additionalProperties: false,
		},
	},
	{
		name: "harness_status",
		description: "Summarize report.json from a finished run directory. Offline.",
		inputSchema: {
			type: "object",
			properties: { output: { type: "string", description: "Harness output directory" } },
			required: ["output"],
			additionalProperties: false,
		},
	},
	{
		name: "harness_evaluate",
		description: "Score the operator's labels against their report. Offline. Not real-world recall.",
		inputSchema: {
			type: "object",
			properties: {
				report: { type: "string", description: "Path to report.json" },
				labels: { type: "string", description: "Path to the operator's labels.json" },
			},
			required: ["report", "labels"],
			additionalProperties: false,
		},
	},
];

function flagValue(name, fallback) {
	const index = process.argv.indexOf(name);
	const next = index >= 0 ? process.argv[index + 1] : undefined;
	if (index >= 0 && next && !next.startsWith("-")) return next;
	return fallback;
}

function textResult(payload, isError = false) {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

const SAFE_ERROR_PREFIXES = [
	"Invalid secgin configuration:",
	"Unsafe snapshot",
	"Snapshot ",
	"Output must be outside the source root",
	"Authorization expired",
	"secgin run store:",
	"scope.json is not valid JSON",
];

function safeError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) return message;
	if (error && typeof error === "object" && error.code === "ENOENT") return "file not found";
	return "secgin failed; check the scope, output directory and private task ledger.";
}

// ---- the single in-memory run -------------------------------------------------

let session = null;

async function startSession(scopePath, outputPath) {
	const configPath = resolve(scopePath);
	const output = resolve(outputPath);
	let config;
	try {
		config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("scope.json is not valid JSON");
		throw error;
	}
	const snapshot = await loadSnapshot(config, dirname(configPath));
	const within = relative(snapshot.root, output);
	if (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("Output must be outside the source root");
	}
	const identity = runIdentity(config, snapshot);
	const store = new RunStore(output, identity);
	const client = new CallbackClient();
	const final = existsSync(join(output, FINAL_MARKER));
	const next = {
		output,
		config,
		snapshot,
		store,
		client,
		final,
		done: false,
		error: null,
		report: null,
	};
	next.runPromise = runHarness(config, snapshot, store, client)
		.then((report) => {
			writeReports(output, report, { final });
			next.report = report;
		})
		.catch((error) => {
			next.error = error;
		})
		.finally(() => {
			next.done = true;
			client.onPrompt(null);
			try {
				store.close();
			} catch {}
		});
	session = next;
	return next;
}

// Resolve once the pipeline is either waiting on the agent (prompts queued) or finished.
function waitForTurn(active) {
	return new Promise((resolveTurn) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			active.client.onPrompt(null);
			// let the rest of a concurrent wave finish enqueuing before we snapshot it
			setImmediate(() => setImmediate(resolveTurn));
		};
		const check = () => {
			if (active.done || active.client.outbox().length > 0) finish();
		};
		active.client.onPrompt(check);
		// completion sets active.done without parking a prompt, so re-check when the run settles
		active.runPromise.then(check, check);
		check();
	});
}

function renderTurn(active) {
	if (active.error) {
		return textResult({ status: "error", output: active.output, message: safeError(active.error) }, true);
	}
	if (active.done) {
		const report = active.report;
		const complete = report?.status === "complete";
		const summary = {
			status: complete ? "complete" : "incomplete",
			output: active.output,
			candidates: report?.candidates.length ?? 0,
			verifiedFindings: 0,
			reportWritten: active.final,
			artifacts: [
				"architecture.md",
				"x-ray.md",
				"fizz-proposed.md",
				"findings.json",
				"FINDINGS-DETAIL.md",
				"HYPOTHESES.jsonl",
				"INVESTIGATION_PLAN.json",
				...(active.final ? ["report.md", "report.json"] : []),
			],
			note: complete
				? "All planned tasks completed. This is not proof the target is secure, and no candidate is confirmed until a human reproduces it."
				: "Some tasks remain pending or failed. Re-run harness_run with the same output to continue them.",
		};
		if (!active.final) {
			summary.finalReportGate = `Wave 4 is gated. Create an empty file named ${FINAL_MARKER} in ${active.output}, then call harness_run again (it resumes instantly) to emit report.md and report.json.`;
		}
		const warning = report ? nestedRuntimeWarning(report.nestedRuntime) : null;
		if (warning) summary.warning = warning;
		return textResult(summary);
	}
	const pending = active.client.outbox().map((item) => ({
		id: item.id,
		role: item.role,
		maxOutputTokens: item.maxOutputTokens,
		system: item.system,
		prompt: item.prompt,
	}));
	return textResult({
		status: "need-agent-work",
		output: active.output,
		pending,
		instructions:
			"You are the only model. For each pending item act in its 'role' (recon maps the target; hunter looks for defects; validator adversarially disproves candidates), read system + prompt, and return EXACTLY the JSON object the prompt specifies — nothing else. Then call harness_submit with answers:[{id,text}]. You may dispatch independent items to parallel sub-agents; keep hunting and validation on separate reads so they cross-check. secgin reads source only: never run the target, exploits, patches or tests.",
	});
}

async function runTool(name, args) {
	if (name === "harness_plan") {
		if (typeof args.scope !== "string" || !args.scope.trim()) {
			return textResult("Usage: harness_plan with scope set to YOUR scope.json. No canned target.", true);
		}
		const configPath = resolve(args.scope);
		let config;
		try {
			config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
		} catch (error) {
			if (error instanceof SyntaxError) return textResult("scope.json is not valid JSON", true);
			throw error;
		}
		const snapshot = await loadSnapshot(config, dirname(configPath));
		const tasks = plan(config);
		return textResult({
			identity: runIdentity(config, snapshot),
			snapshot: snapshot.digest,
			files: snapshot.files.map(({ path, sha256, lines }) => ({ path, sha256, lines })),
			tools: HARNESS_TOOLS,
			waves: {
				"0-recon": ["recon:architecture", "recon:threats", "recon:invariants", "recon"],
				"1-hypotheses": "HYPOTHESES.jsonl is written from recon before Wave 2",
				"2-investigate": tasks.map(({ id }) => id),
				"3-adjudicate": ["vdh.validate", "vdh.reverify", "vvs.dedup", "vvs.judgment", "vvs.fixing"],
				"4-reconcile": "report.md / report.json, gated on FINAL_REPORT_AUTHORIZED",
			},
			agentDeclared: ["vdh.sibling", "vdh.gapfill", "vdh.wishlist"],
			pashov: loadInstalledPashov(),
			mdpsec: loadInstalledMdpsec(),
			pashovMapped: {
				"x-ray": ["recon:architecture", "recon:threats", "recon:invariants", "recon"],
				"solidity-auditor": Object.keys(LENSES.web3).map((id) => `hunt:web3:${id}:0`),
				fizz: config.domains.includes("web3") ? ["pashov.fizz"] : [],
			},
			hunts: tasks.map(({ id }) => id),
			baseCalls: 4 + (config.domains.includes("web3") ? 1 : 0) + tasks.length,
			hardCallCap: config.limits.maxCalls,
			nestedRuntime: inspectNestedRuntime(),
			note: "secgin calls no provider models and transmits no source. The driving agent answers every stage prompt. Recon runs first and may add attack-class hunts. Empty cells are gapfilled once. Hunting and validation are kept on separate reads. Patches and tests are never executed.",
			warning: "Plan makes no model calls. Scope is an operator attestation, not proof of program authorization.",
		});
	}
	if (name === "harness_run") {
		if (args.confirmed !== true) return textResult("Operator must set confirmed=true.", true);
		if (typeof args.scope !== "string" || typeof args.output !== "string") {
			return textResult("Usage: harness_run with scope, output, and confirmed=true.", true);
		}
		const output = resolve(args.output);
		const active =
			session && session.output === output && !session.done && !session.error
				? session
				: session && !session.done && session.output !== output
					? null
					: await startSession(args.scope, args.output);
		if (!active) {
			return textResult(
				`A run on ${session.output} is still in progress. Finish it with harness_submit, or wait for it to complete, before starting ${output}.`,
				true,
			);
		}
		await waitForTurn(active);
		return renderTurn(active);
	}
	if (name === "harness_next") {
		if (!session) return textResult("No active run. Call harness_run with scope and output first.", true);
		await waitForTurn(session);
		return renderTurn(session);
	}
	if (name === "harness_submit") {
		if (!session) return textResult("No active run. Call harness_run with scope and output first.", true);
		if (session.done) return renderTurn(session);
		if (!Array.isArray(args.answers)) return textResult("Usage: harness_submit with answers:[{id,text}].", true);
		const unknown = [];
		for (const answer of args.answers) {
			if (!answer || typeof answer.id !== "string" || typeof answer.text !== "string") {
				return textResult("Each answer must be {id, text} strings.", true);
			}
			if (!session.client.submit(answer.id, answer.text)) unknown.push(answer.id);
		}
		await waitForTurn(session);
		const turn = renderTurn(session);
		if (unknown.length) {
			const parsed = JSON.parse(turn.content[0].text);
			parsed.ignoredUnknownIds = unknown;
			turn.content[0].text = JSON.stringify(parsed, null, 2);
		}
		return turn;
	}
	if (name === "harness_status") {
		if (typeof args.output !== "string" || !args.output.trim()) {
			return textResult("Usage: harness_status with output set to the run directory.", true);
		}
		return textResult(await readRunStatus(resolve(args.output)));
	}
	if (name === "harness_evaluate") {
		if (typeof args.report !== "string" || typeof args.labels !== "string") {
			return textResult("Usage: harness_evaluate with report.json and labels.json.", true);
		}
		const report = JSON.parse(await readFile(resolve(args.report), "utf8"));
		const labels = JSON.parse(await readFile(resolve(args.labels), "utf8"));
		return textResult(evaluate(report, labels));
	}
	return textResult(`Unknown tool: ${name}`, true);
}

async function callTool(name, args) {
	try {
		return await runTool(name, args);
	} catch (error) {
		return textResult(safeError(error), true);
	}
}

async function handle(message) {
	if (message.method === "initialize") {
		return {
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "secgin", version: "0.2.0" },
			},
		};
	}
	if (message.method === "tools/list") {
		return { result: { tools: TOOLS } };
	}
	if (message.method === "tools/call") {
		const name = message.params?.name;
		const args = message.params?.arguments ?? {};
		if (typeof name !== "string") {
			return { error: { code: -32602, message: "tools/call requires params.name" } };
		}
		return { result: await callTool(name, args) };
	}
	if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
		return null;
	}
	return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
}

async function rpcBody(message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) {
		return { error: { code: -32600, message: "JSON-RPC batch is not supported" } };
	}
	if (message.id === undefined) {
		await handle(message);
		return null;
	}
	const response = await handle(message);
	if (!response) return null;
	return { jsonrpc: "2.0", id: message.id, ...response };
}

function startStdio() {
	const pending = [];
	let draining = false;
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

	async function drain() {
		if (draining) return;
		draining = true;
		while (pending.length > 0) {
			const line = pending.shift();
			if (!line?.trim()) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const body = await rpcBody(message);
			if (body) process.stdout.write(`${JSON.stringify(body)}\n`);
		}
		draining = false;
	}

	input.on("line", (line) => {
		pending.push(line);
		void drain();
	});
}

function startHttp() {
	const port = Number(flagValue("--port", "8787"));
	const bind = flagValue("--bind", "127.0.0.1");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		process.stderr.write("Usage: node server.mjs --http [--port 8787] [--bind 127.0.0.1]\n");
		process.exit(1);
	}
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${bind}`);
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "http://127.0.0.1",
					"Access-Control-Allow-Headers": "content-type, mcp-session-id",
					"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
				});
				res.end();
				return;
			}
			if (url.pathname !== "/" && url.pathname !== "/mcp") {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: -32601, message: "Not found" } }));
				return;
			}
			if (req.method === "GET") {
				res.writeHead(405, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: -32601, message: "POST JSON-RPC to /mcp" } }));
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: -32600, message: "POST JSON-RPC to /mcp" } }));
				return;
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 8_000_000) {
					res.writeHead(413, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { code: -32600, message: "Payload too large" } }));
					return;
				}
				chunks.push(chunk);
			}
			let message;
			try {
				message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
				return;
			}
			const body = await rpcBody(message);
			if (!body) {
				res.writeHead(202);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		})().catch((error) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
					id: null,
				}),
			);
		});
	});
	server.listen(port, bind, () => {
		const address = server.address();
		const actual = typeof address === "object" && address ? address.port : port;
		process.stderr.write(`secgin mcp http://${bind}:${actual}/mcp\n`);
	});
}

if (process.argv.includes("--http")) startHttp();
else startStdio();

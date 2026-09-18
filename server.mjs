import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(fileURLToPath(import.meta.url));

const TOOLS = [
	{
		name: "harness_models",
		description: "List catalog models for recon, hunter, and validator. Offline. Hunter and validator must differ.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "harness_plan",
		description: "Validate YOUR scope.json offline and print planned VDH/VVS work. No model calls. No canned target.",
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
			"Run VDH then VVS against the operator's scope. Requires confirmed=true. Uses models already in scope.json. Never a demo target.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", description: "Path to the operator's scope.json" },
				output: { type: "string", description: "Output directory outside the source root" },
				confirmed: {
					type: "boolean",
					description: "Must be true. Sends scoped source to the models in the scope file.",
				},
			},
			required: ["scope", "output", "confirmed"],
			additionalProperties: false,
		},
	},
	{
		name: "harness_status",
		description: "Summarize report.json from a finished harness output directory.",
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

function resolveWorker() {
	return resolve(pluginRoot, "cli.ts");
}

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function invokeCli(args) {
	const cli = resolveWorker();
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 80_000) stdout = `${stdout.slice(0, 80_000)}\n…truncated…\n`;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > 20_000) stderr = `${stderr.slice(0, 20_000)}\n…truncated…\n`;
		});
		child.on("error", (error) => {
			resolvePromise({ status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
		});
		child.on("close", (code) => {
			resolvePromise({ status: code ?? 1, stdout, stderr });
		});
	});
}

async function callTool(name, args) {
	if (name === "harness_models") {
		const result = await invokeCli(["models"]);
		return textResult(result.stdout || result.stderr, result.status !== 0);
	}
	if (name === "harness_plan") {
		if (typeof args.scope !== "string" || !args.scope.trim()) {
			return textResult("Usage: harness_plan with scope set to YOUR scope.json. No canned target.", true);
		}
		const result = await invokeCli(["plan", args.scope]);
		return textResult(result.stdout || result.stderr, result.status !== 0);
	}
	if (name === "harness_status") {
		if (typeof args.output !== "string" || !args.output.trim()) {
			return textResult("Usage: harness_status with output set to the run directory.", true);
		}
		const result = await invokeCli(["status", args.output]);
		return textResult(result.stdout || result.stderr, result.status !== 0);
	}
	if (name === "harness_evaluate") {
		if (typeof args.report !== "string" || typeof args.labels !== "string") {
			return textResult("Usage: harness_evaluate with report.json and labels.json.", true);
		}
		const result = await invokeCli(["evaluate", args.report, args.labels]);
		return textResult(result.stdout || result.stderr, result.status !== 0);
	}
	if (name === "harness_run") {
		if (args.confirmed !== true) {
			return textResult("Operator must set confirmed=true. No model calls.", true);
		}
		if (typeof args.scope !== "string" || typeof args.output !== "string") {
			return textResult("Usage: harness_run with scope, output, and confirmed=true.", true);
		}
		const result = await invokeCli(["run", args.scope, args.output, "--allow-remote-models", "--keep-models"]);
		return textResult(result.stdout || result.stderr || `exit ${result.status}`, result.status !== 0);
	}
	return textResult(`Unknown tool: ${name}`, true);
}

async function handle(message) {
	if (message.method === "initialize") {
		return {
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "security-harness", version: "0.1.0" },
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
				if (size > 1_000_000) {
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
		process.stderr.write(`security-harness mcp http://${bind}:${actual}/mcp\n`);
	});
}

if (process.argv.includes("--http")) startHttp();
else startStdio();

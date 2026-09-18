import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.SECGIN_HOME?.trim() || dirname(here);
const server = join(root, "server.mjs");
const expected = ["harness_models", "harness_plan", "harness_run", "harness_status", "harness_evaluate"];

const child = spawn(process.execPath, [server], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);

const chunks = [];
const listed = await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("timeout waiting for tools/list")), 15000);
	child.stdout.on("data", (chunk) => {
		chunks.push(chunk);
		const text = Buffer.concat(chunks).toString("utf8");
		const line = text.split("\n").find((item) => item.trim());
		if (!line) return;
		clearTimeout(timer);
		resolve(JSON.parse(line));
	});
});
child.kill("SIGTERM");

const names = listed.result.tools.map((tool) => tool.name);
if (JSON.stringify(names) !== JSON.stringify(expected)) {
	throw new Error(`unexpected tools: ${JSON.stringify(names)}`);
}
process.stdout.write(`${names.join(" ")}\n`);

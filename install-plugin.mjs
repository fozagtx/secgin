import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL(".", import.meta.url));
const skipNames = new Set([
	".git",
	".github",
	".claude-plugin",
	".agents",
	"node_modules",
	"install-plugin.mjs",
	"package.json",
	"package-lock.json",
	".gitignore",
	"AGENTS.md",
	"scripts",
]);
const HOSTS = ["minimax", "codex", "claude", "cloud", "dest", "all"];

const HELP = `Install this repository as an Agent Plugins 1.0 package into a host CLI.

  git clone https://github.com/fozagtx/secgin
  node install-plugin.mjs --host minimax|codex|claude|cloud|dest|all
  node install-plugin.mjs --host dest --path /your/plugin-dir

The JSON worker is the backbone. --host selects the CLI adapter. dest is a generic copy for any other agent.
stdio MCP for local hosts. Cloud uses node server.mjs --http.
`;

function argValue(name) {
	const index = process.argv.indexOf(name);
	const next = index >= 0 ? process.argv[index + 1] : undefined;
	return index >= 0 && next && !next.startsWith("-") ? next : undefined;
}

function parseHost() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		process.stdout.write(HELP);
		process.exit(0);
	}
	const host = argValue("--host");
	if (!host) {
		throw new Error(`--host is required. Use ${HOSTS.join("|")}.`);
	}
	if (!HOSTS.includes(host)) {
		throw new Error(`Unknown --host ${host}. Use ${HOSTS.join("|")}.`);
	}
	return host;
}

function emptyDir(target) {
	mkdirSync(path.dirname(target), { recursive: true });
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
}

function copyWorker(target) {
	for (const name of readdirSync(repo)) {
		if (skipNames.has(name) || name.endsWith(".test.ts") || name.endsWith(".tsbuildinfo")) continue;
		cpSync(path.join(repo, name), path.join(target, name), { recursive: true });
	}
}

function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function stdioMcp(serverPath) {
	return {
		command: "node",
		args: [serverPath],
	};
}

function upsertNamed(list, name, entry) {
	const next = list.filter((item) => item && item.name !== name);
	next.push(entry);
	return next;
}

function installMinimax() {
	const dataDir = process.env.MINIMAX_DATA_DIR?.trim() || path.join(homedir(), ".minimax-code");
	const target = path.join(dataDir, "plugins", "security-harness");
	emptyDir(target);
	copyWorker(target);
	return [`minimax ${target}`];
}

function installCodex() {
	const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
	const target = path.join(codexHome, "plugins", "security-harness");
	emptyDir(target);
	copyWorker(target);
	const marketplacePath =
		process.env.AGENTS_PLUGINS_MARKETPLACE?.trim() ||
		path.join(homedir(), ".agents", "plugins", "marketplace.json");
	const sourcePath = "./.codex/plugins/security-harness";
	const entry = {
		name: "security-harness",
		source: { source: "local", path: sourcePath },
		policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
		category: "Security",
	};
	let marketplace = {
		name: "local-plugins",
		interface: { displayName: "Local plugins" },
		plugins: [],
	};
	if (existsSync(marketplacePath)) {
		const loaded = readJson(marketplacePath);
		if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
			throw new Error(`${marketplacePath} is not a marketplace object`);
		}
		marketplace = loaded;
		if (!Array.isArray(marketplace.plugins)) marketplace.plugins = [];
	}
	marketplace.plugins = upsertNamed(marketplace.plugins, "security-harness", entry);
	writeJson(marketplacePath, marketplace);
	return [`codex ${target}`, `codex marketplace ${marketplacePath}`];
}

function installClaude() {
	const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
	const target = path.join(claudeHome, "plugins", "security-harness");
	emptyDir(target);
	copyWorker(target);
	writeJson(path.join(target, ".claude-plugin", "plugin.json"), {
		name: "security-harness",
		version: "0.1.0",
		description: "Authorized local-source VDH/VVS security research. No canned target.",
	});
	writeJson(path.join(target, ".mcp.json"), {
		mcpServers: {
			"security-harness": stdioMcp("./server.mjs"),
		},
	});
	const marketplacePath = path.join(claudeHome, "plugins", "marketplace.json");
	writeJson(marketplacePath, {
		name: "security-harness-local",
		plugins: [{ name: "security-harness", source: "./security-harness" }],
	});
	return [`claude ${target}`, `claude marketplace ${marketplacePath}`];
}

function installCloud() {
	const pluginHome = process.env.SECURITY_HARNESS_HOME?.trim() || path.join(homedir(), ".security-harness");
	emptyDir(pluginHome);
	copyWorker(pluginHome);
	const server = path.join(pluginHome, "server.mjs");
	process.stdout.write(`Cloud MCP (loopback Streamable HTTP):\n  node ${server} --http --port 8787\n`);
	process.stdout.write("Point the cloud agent at http://127.0.0.1:8787/mcp\n");
	return [`cloud ${pluginHome}`];
}

function installDest() {
	const dest = argValue("--path");
	if (!dest?.trim()) throw new Error("--host dest requires --path /absolute-or-relative-dir");
	const target = path.resolve(dest.trim());
	emptyDir(target);
	copyWorker(target);
	return [`dest ${target}`];
}

function install(host) {
	if (host === "minimax") return installMinimax();
	if (host === "codex") return installCodex();
	if (host === "claude") return installClaude();
	if (host === "cloud") return installCloud();
	if (host === "dest") return installDest();
	return [...installMinimax(), ...installCodex(), ...installClaude()];
}

try {
	const lines = install(parseHost());
	for (const line of lines) process.stdout.write(`Installed ${line}\n`);
	process.stdout.write(
		"Restart the host. Skill: security-harness. MCP: harness_models, harness_plan, harness_run, harness_status, harness_evaluate.\n",
	);
	process.stdout.write(
		"Hunt models come from YOUR scope.json, not from the host CLI. Set keys for the providers in that file.\n",
	);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

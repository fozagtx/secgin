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
  node install-plugin.mjs --host minimax | codex | claude | cloud | dest (--path DIR, any other agent) | all
  node install-plugin.mjs --host dest --path /your/plugin-dir

The JSON worker is the backbone. --host selects the CLI adapter. dest is a generic copy for any other agent.
stdio MCP for local hosts. Cloud uses node server.mjs --http.
Every install prints a generic Skill path + MCP stdio/HTTP snippet for hosts without a built-in adapter.
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
	target = path.resolve(target);
	const repoPath = path.resolve(repo);
	const repoRelative = path.relative(target, repoPath);
	const protectsRepo =
		repoRelative === "" || (!repoRelative.startsWith("..") && !path.isAbsolute(repoRelative));
	const protectedTargets = new Set([path.parse(target).root, path.resolve(homedir()), path.resolve(process.cwd())]);
	if (protectedTargets.has(target) || protectsRepo) {
		throw new Error(`Refusing to remove protected directory ${target}`);
	}
	if (existsSync(target)) {
		let nonEmpty = true;
		try {
			nonEmpty = readdirSync(target).length > 0;
		} catch {
			nonEmpty = true;
		}
		if (nonEmpty) {
			let isSecginInstall = false;
			try {
				isSecginInstall = readJson(path.join(target, "plugin.json"))?.name === "secgin";
			} catch {
				isSecginInstall = false;
			}
			if (!isSecginInstall) {
				throw new Error(
					`Refusing to overwrite non-empty directory ${target}: it is not an existing secgin install`,
				);
			}
		}
	}
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
	const target = path.join(dataDir, "plugins", "secgin");
	emptyDir(target);
	copyWorker(target);
	return { lines: [`minimax ${target}`], targets: [target] };
}

function installCodex() {
	const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
	const target = path.join(codexHome, "plugins", "secgin");
	emptyDir(target);
	copyWorker(target);
	const marketplacePath =
		process.env.AGENTS_PLUGINS_MARKETPLACE?.trim() ||
		path.join(homedir(), ".agents", "plugins", "marketplace.json");
	const relativeTarget = path.relative(homedir(), target);
	const sourcePath =
		relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)
			? target
			: `./${relativeTarget.split(path.sep).join("/")}`;
	const entry = {
		name: "secgin",
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
	marketplace.plugins = upsertNamed(marketplace.plugins, "secgin", entry);
	writeJson(marketplacePath, marketplace);
	return {
		lines: [`codex ${target}`, `codex marketplace ${marketplacePath}`],
		targets: [target],
	};
}

function installClaude() {
	const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
	const target = path.join(claudeHome, "plugins", "secgin");
	emptyDir(target);
	copyWorker(target);
	writeJson(path.join(target, ".claude-plugin", "plugin.json"), {
		name: "secgin",
		version: "0.1.0",
		description: "Authorized local-source VDH/VVS security research. No canned target.",
	});
	writeJson(path.join(target, ".mcp.json"), {
		mcpServers: {
			"secgin": stdioMcp("${CLAUDE_PLUGIN_ROOT}/server.mjs"),
		},
	});
	const marketplacePath = path.join(claudeHome, "plugins", "marketplace.json");
	writeJson(marketplacePath, {
		name: "secgin-local",
		plugins: [{ name: "secgin", source: "./secgin" }],
	});
	return {
		lines: [`claude ${target}`, `claude marketplace ${marketplacePath}`],
		targets: [target],
	};
}

function printGenericWiring(target) {
	const server = path.join(target, "server.mjs");
	process.stdout.write(
		`Wire any other agent:\n  Skill file: ${path.join(target, "skills", "secgin", "SKILL.md")}\n` +
			`  MCP (stdio): ${JSON.stringify({ mcpServers: { secgin: stdioMcp(server) } })}\n` +
			`  MCP (HTTP):  node ${server} --http --port 8787   ->  http://127.0.0.1:8787/mcp\n`,
	);
}

function installCloud() {
	const pluginHome = process.env.SECGIN_HOME?.trim() || path.join(homedir(), ".secgin");
	emptyDir(pluginHome);
	copyWorker(pluginHome);
	const server = path.join(pluginHome, "server.mjs");
	process.stdout.write(`Cloud MCP (loopback Streamable HTTP):\n  node ${server} --http --port 8787\n`);
	process.stdout.write("Point the cloud agent at http://127.0.0.1:8787/mcp\n");
	return { lines: [`cloud ${pluginHome}`], targets: [pluginHome] };
}

function installDest() {
	const dest = argValue("--path");
	if (!dest?.trim()) throw new Error("--host dest requires --path /absolute-or-relative-dir");
	const target = path.resolve(dest.trim());
	emptyDir(target);
	copyWorker(target);
	return { lines: [`dest ${target}`], targets: [target] };
}

function install(host) {
	if (host === "minimax") return installMinimax();
	if (host === "codex") return installCodex();
	if (host === "claude") return installClaude();
	if (host === "cloud") return installCloud();
	if (host === "dest") return installDest();
	const installs = [installMinimax(), installCodex(), installClaude()];
	return {
		lines: installs.flatMap((result) => result.lines),
		targets: installs.flatMap((result) => result.targets),
	};
}

try {
	const result = install(parseHost());
	const lines = result.lines;
	for (const line of lines) process.stdout.write(`Installed ${line}\n`);
	for (const target of result.targets) printGenericWiring(target);
	process.stdout.write(
		"Restart the host. Skill: secgin. MCP: harness_models, harness_plan, harness_run, harness_status, harness_evaluate.\n",
	);
	process.stdout.write(
		"Hunt models come from YOUR scope.json, not from the host CLI. Set keys for the providers in that file.\n",
	);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

import { createHash } from "node:crypto";
import { text } from "./schema.ts";

/** Cloudflare VDH + VVS stages. Models declare these; they cannot execute them. */
export const HARNESS_TOOLS = {
	"vdh.recon": "Map architecture and write the threat model (three parallel recon passes, then a synthesis).",
	"vdh.hunt": "Per-class attack against one coverage cell. Stay on this cell; fork a sibling instead of wandering.",
	"vdh.validate": "Mechanical schema/path/quote/function checks, then an isolated agent tries to disprove the candidate.",
	"vdh.reverify": "Fresh agent, different from the hunter, checks every factual claim in a surviving candidate against source. Cannot file findings. Verified is not confirmed.",
	"vdh.gapfill": "Enqueue a fresh hunt for a shallow (area × attack-class) cell that returned zero findings. Repeat until cells stop being shallow or the call cap hits.",
	"vdh.dedup": "Cluster overlapping candidates by root cause using deterministic keys, then optional agent shortlist.",
	"vdh.trace": "Walk in-snapshot dependencies; in-snapshot consumers get a sibling hunt, missing repos go to the wishlist.",
	"vdh.feedback": "Rewrite queued hunt prompts from validation failures, shallow cells, and repeated misses.",
	"vdh.report": "Script-only human-readable report. Models must not write this file themselves.",
	"vdh.sibling": "Fork a sibling hunt with a structural seed when an interesting path is outside the current cell.",
	"vdh.wishlist": "Request a missing dependency (build, VM, prod config, consumer repo). Do not invent the result.",
	"vvs.dedup": "Inverted-index shortlist then agent check: reopen a stable key instead of filing a duplicate.",
	"vvs.judgment": "Source-only reachability/risk class. Not production MCP. Different model than the hunter.",
	"vvs.fixing": "Propose a patch and a local test against the original snapshot. Never apply, merge, or run tests.",
	"pashov.xray":
		"Pashov x-ray from https://github.com/pashov/skills: pre-audit threat model, invariants, entry points on scoped source. enumerate.sh / forge coverage / git scripts are not executed.",
	"pashov.auditor":
		"Pashov solidity-auditor from https://github.com/pashov/skills: twelve parallel hunt cells. The orchestrator runs them; models only declare this tool.",
	"pashov.fizz":
		"Pashov fizz from https://github.com/pashov/skills: propose Echidna/Medusa invariant properties. Never write test/fizz into the target. Never run a fuzzer.",
} as const;

export type HarnessToolName = keyof typeof HARNESS_TOOLS;

export const HARNESS_TOOL_NAMES = Object.keys(HARNESS_TOOLS) as HarnessToolName[];

export interface DeclaredTool {
	tool: HarnessToolName;
	reason: string;
	seed?: string;
	lens?: string;
	need?: string;
	cell?: string;
	fromPath?: string;
	toPath?: string;
	rewrite?: string;
}

const OPTIONAL_TOOL_KEYS = ["seed", "lens", "need", "cell", "fromPath", "toPath", "rewrite"] as const;

export function toolCatalogText(): string {
	return HARNESS_TOOL_NAMES.map((name) => `- ${name}: ${HARNESS_TOOLS[name]}`).join("\n");
}

export function peelTools(value: unknown): { body: unknown; tools: DeclaredTool[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { body: value, tools: [] };
	const record = value as Record<string, unknown>;
	if (!("tools" in record)) return { body: value, tools: [] };
	const { tools: raw, ...rest } = record;
	return { body: rest, tools: parseDeclaredTools(raw) };
}

export function parseDeclaredTools(value: unknown): DeclaredTool[] {
	if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid tools list");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid tool declaration");
		const record = item as Record<string, unknown>;
		const keys = Object.keys(record);
		if (!keys.includes("tool") || !keys.includes("reason") || keys.some((key) => key !== "tool" && key !== "reason" && !OPTIONAL_TOOL_KEYS.includes(key as (typeof OPTIONAL_TOOL_KEYS)[number]))) {
			throw new Error("Invalid tool declaration");
		}
		const name = text(record.tool);
		if (!HARNESS_TOOL_NAMES.includes(name as HarnessToolName)) throw new Error("Unknown harness tool");
		const declared: DeclaredTool = { tool: name as HarnessToolName, reason: text(record.reason) };
		for (const key of OPTIONAL_TOOL_KEYS) {
			if (record[key] !== undefined) declared[key] = text(record[key]);
		}
		return declared;
	});
}

export function siblingTaskId(seed: string): string {
	return `hunt:sibling:${createHash("sha256").update(seed).digest("hex").slice(0, 12)}:0`;
}

export function wishlistTaskId(need: string): string {
	return `wishlist:${createHash("sha256").update(need).digest("hex").slice(0, 16)}`;
}

export function stageLine(tool: HarnessToolName): string {
	return `STAGE=${tool}`;
}

export function promptStage(prompt: string): HarnessToolName | null {
	const match = /^STAGE=(\S+)/m.exec(prompt);
	if (!match || !HARNESS_TOOL_NAMES.includes(match[1] as HarnessToolName)) return null;
	return match[1] as HarnessToolName;
}

/** Deterministic import/require edges used by vdh.trace. Out-of-snapshot specs become wishlist needs. */
export function traceDependencies(files: { path: string; content: string }[]): {
	edges: { fromPath: string; toPath: string }[];
	missing: string[];
} {
	const indexed = new Map(files.map((file) => [file.path, file]));
	const edges: { fromPath: string; toPath: string }[] = [];
	const missing: string[] = [];
	const seenMissing = new Set<string>();
	for (const file of files) {
		const pattern = /(?:import|from|require)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
		for (const match of file.content.matchAll(pattern)) {
			const spec = match[1];
			if (!spec || spec.startsWith("node:") || spec.startsWith("http:") || spec.startsWith("https:")) continue;
			if (spec.startsWith(".")) {
				const resolved = resolveRelative(file.path, spec);
				const hit = [...indexed.keys()].find((path) => path === resolved || path.startsWith(`${resolved}.`) || path === `${resolved}.ts` || path === `${resolved}.js`);
				if (hit) edges.push({ fromPath: file.path, toPath: hit });
				else if (!seenMissing.has(spec) && seenMissing.size < 12) {
					seenMissing.add(spec);
					missing.push(`in-snapshot path not listed in scope: ${spec} (from ${file.path})`);
				}
				continue;
			}
			if (!seenMissing.has(spec) && seenMissing.size < 12) {
				seenMissing.add(spec);
				missing.push(`dependency or consumer repo not in this snapshot: ${spec} (from ${file.path})`);
			}
		}
	}
	return { edges, missing };
}

function resolveRelative(fromPath: string, spec: string): string {
	const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
	const parts = [...(fromDir ? fromDir.split("/") : []), ...spec.split("/")];
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") resolved.pop();
		else resolved.push(part);
	}
	return resolved.join("/");
}

export function invertedIndexShortlist(
	candidate: { id: string; clusterId: string; finding: { trustBoundary: string; rootCause: string; evidence: { path: string }[] } },
	pool: { id: string; clusterId: string; finding: { trustBoundary: string; rootCause: string; evidence: { path: string }[] } }[],
): string[] {
	const files = new Set(candidate.finding.evidence.map((cite) => cite.path));
	const tokens = rareTokens(candidate.finding.rootCause);
	const scored = pool
		.filter((other) => other.id !== candidate.id)
		.map((other) => {
			let score = 0;
			if (other.clusterId === candidate.clusterId) score += 3;
			if (other.finding.trustBoundary === candidate.finding.trustBoundary) score += 2;
			if (other.finding.evidence.some((cite) => files.has(cite.path))) score += 2;
			score += rareTokens(other.finding.rootCause).filter((token) => tokens.includes(token)).length;
			return { id: other.id, score };
		})
		.filter((row) => row.score >= 2)
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
	return scored.slice(0, 8).map((row) => row.id);
}

function rareTokens(value: string): string[] {
	return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 5))].slice(0, 12);
}

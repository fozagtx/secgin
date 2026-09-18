import { createHash } from "node:crypto";
import { mechanicalCitationCheck, mechanicalFixCheck, vacuousFinding } from "./mechanical.ts";
import { SOLIDITY_AUDITOR_LENS_IDS } from "./pashov.ts";
import type { Snapshot } from "./scope.ts";

export interface Citation {
	path: string;
	startLine: number;
	endLine: number;
	quote: string;
}

export interface Finding {
	title: string;
	severity: "critical" | "high" | "medium" | "low";
	attacker: string;
	intentBroken: string;
	attackClass: string;
	preconditions: string[];
	trustBoundary: string;
	rootCause: string;
	impact: string;
	reproduction: string[];
	remediation: string;
	evidence: Citation[];
}

export interface AttackClass {
	id: string;
	methodology: string;
}

export interface Recon {
	summary: string;
	architecture: string;
	actors: string[];
	entryPoints: string[];
	trustBoundaries: string[];
	invariants: string[];
	attackClasses: AttackClass[];
	missingContext: string[];
}

export interface Judgment {
	verdict: "exploitable-in-source" | "latent" | "wrong-component" | "not-a-risk";
	reason: string;
	evidence: Citation[];
	missingContext: string[];
}

export interface FixProposal {
	patch: string;
	test: string;
	notes: string;
	blocked: true;
	blockReason: string;
}

export interface Feedback {
	notes: string;
	sharperLenses: { cell: string; lens: string }[];
}

export interface FizzProposal {
	properties: { name: string; invariant: string; handlerHint: string }[];
	blockers: string[];
}

export interface Verdict {
	verdict: "supported" | "rejected" | "needs-context";
	reason: string;
	evidence: Citation[];
	missingContext: string[];
}

export function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
		throw new Error("Unexpected or missing fields");
	}
	return result;
}

export function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 8000) throw new Error("Invalid text field");
	return value;
}

function texts(value: unknown, allowEmpty = false): string[] {
	if (!Array.isArray(value) || value.length > 40 || (!allowEmpty && value.length === 0)) {
		throw new Error("Invalid text list");
	}
	return value.map(text);
}

function citations(value: unknown, snapshot: Snapshot, allowEmpty = false): Citation[] {
	if (!Array.isArray(value) || value.length > 12 || (!allowEmpty && !value.length)) {
		throw new Error("Invalid evidence list");
	}
	return value.map((item) => {
		const row = object(item, ["path", "startLine", "endLine", "quote"]);
		const path = text(row.path);
		const file = snapshot.files.find((file) => file.path === path);
		const startLine = row.startLine;
		const endLine = row.endLine;
		if (
			!file ||
			typeof startLine !== "number" ||
			typeof endLine !== "number" ||
			!Number.isInteger(startLine) ||
			!Number.isInteger(endLine) ||
			startLine < 1 ||
			endLine < startLine ||
			endLine > file.lines ||
			endLine - startLine > 80
		)
			throw new Error("Evidence is outside the source snapshot");
		const quote = text(row.quote);
		const actual = file.content
			.split("\n")
			.slice(startLine - 1, endLine)
			.join("\n");
		if (actual !== quote) throw new Error("Evidence quote does not match cited lines exactly");
		mechanicalCitationCheck(snapshot, [{ path, startLine, endLine, quote }]);
		return { path, startLine, endLine, quote };
	});
}

const ATTACK_CLASS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BUILTIN_LENS_IDS = new Set([
	"identity-and-tenancy",
	"input-to-sink",
	"network-and-protocol",
	"state-and-business-logic",
	"crypto-and-secrets",
	"memory-timing-and-parsers",
	...SOLIDITY_AUDITOR_LENS_IDS,
]);

const FINDING_KEYS = [
	"title",
	"severity",
	"attacker",
	"intentBroken",
	"attackClass",
	"preconditions",
	"trustBoundary",
	"rootCause",
	"impact",
	"reproduction",
	"remediation",
	"evidence",
] as const;

function attackClasses(value: unknown): AttackClass[] {
	if (!Array.isArray(value) || value.length > 6) throw new Error("Invalid attack class list");
	const classes = value.map((item) => {
		const row = object(item, ["id", "methodology"]);
		const id = text(row.id);
		if (!ATTACK_CLASS_ID.test(id) || id.length > 40 || BUILTIN_LENS_IDS.has(id)) {
			throw new Error("Invalid attack class id");
		}
		return { id, methodology: text(row.methodology) };
	});
	if (new Set(classes.map((item) => item.id)).size !== classes.length) throw new Error("Duplicate attack class id");
	return classes;
}

export function parseRecon(value: unknown): Recon {
	const row = object(value, [
		"summary",
		"architecture",
		"actors",
		"entryPoints",
		"trustBoundaries",
		"invariants",
		"attackClasses",
		"missingContext",
	]);
	return {
		summary: text(row.summary),
		architecture: text(row.architecture),
		actors: texts(row.actors, true),
		entryPoints: texts(row.entryPoints),
		trustBoundaries: texts(row.trustBoundaries),
		invariants: texts(row.invariants),
		attackClasses: attackClasses(row.attackClasses),
		missingContext: texts(row.missingContext, true),
	};
}

export function parseFizz(value: unknown): FizzProposal {
	const row = object(value, ["properties", "blockers"]);
	if (!Array.isArray(row.properties) || row.properties.length > 16) throw new Error("Invalid fizz properties");
	if (!Array.isArray(row.blockers) || row.blockers.length > 16) throw new Error("Invalid fizz blockers");
	return {
		properties: row.properties.map((item) => {
			const property = object(item, ["name", "invariant", "handlerHint"]);
			return { name: text(property.name), invariant: text(property.invariant), handlerHint: text(property.handlerHint) };
		}),
		blockers: row.blockers.map(text),
	};
}

export function parseFeedback(value: unknown): Feedback {
	const row = object(value, ["notes", "sharperLenses"]);
	if (!Array.isArray(row.sharperLenses) || row.sharperLenses.length > 24) throw new Error("Invalid sharperLenses list");
	return {
		notes: text(row.notes),
		sharperLenses: row.sharperLenses.map((item) => {
			const lens = object(item, ["cell", "lens"]);
			return { cell: text(lens.cell), lens: text(lens.lens) };
		}),
	};
}

export function parseJudgment(value: unknown, snapshot: Snapshot): Judgment {
	const row = object(value, ["verdict", "reason", "evidence", "missingContext"]);
	const verdict = row.verdict;
	if (
		verdict !== "exploitable-in-source" &&
		verdict !== "latent" &&
		verdict !== "wrong-component" &&
		verdict !== "not-a-risk"
	) {
		throw new Error("Invalid judgment");
	}
	return {
		verdict,
		reason: text(row.reason),
		evidence: citations(row.evidence, snapshot, true),
		missingContext: texts(row.missingContext, true),
	};
}

export function parseFixProposal(value: unknown): FixProposal {
	const row = object(value, ["patch", "test", "notes", "blocked", "blockReason"]);
	if (typeof row.blocked !== "boolean") throw new Error("Invalid fix proposal");
	const patch = text(row.patch);
	const test = text(row.test);
	mechanicalFixCheck(patch, test);
	return {
		patch,
		test,
		notes: text(row.notes),
		blocked: true,
		blockReason: row.blocked
			? text(row.blockReason)
			: "Harness blocked apply/merge: a human must review; tests are not executed",
	};
}

export function parseHunt(
	value: unknown,
	snapshot: Snapshot,
	limit: number,
): { findings: Finding[]; coverage: string } {
	const row = object(value, ["findings", "coverage"]);
	if (!Array.isArray(row.findings) || row.findings.length > limit) throw new Error("Invalid findings count");
	const findings = row.findings.map((item): Finding => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid finding");
		const keyOrder = Object.keys(item as object);
		if (keyOrder.join(",") !== FINDING_KEYS.join(",")) throw new Error("Finding keys must follow threat-model-first order");
		const finding = object(item, [...FINDING_KEYS]);
		const severity = finding.severity;
		if (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low") {
			throw new Error("Invalid severity");
		}
		const parsed: Finding = {
			title: text(finding.title),
			severity,
			attacker: text(finding.attacker),
			intentBroken: text(finding.intentBroken),
			attackClass: text(finding.attackClass),
			preconditions: texts(finding.preconditions),
			trustBoundary: text(finding.trustBoundary),
			rootCause: text(finding.rootCause),
			impact: text(finding.impact),
			reproduction: texts(finding.reproduction),
			remediation: text(finding.remediation),
			evidence: citations(finding.evidence, snapshot),
		};
		const junk = vacuousFinding(parsed);
		if (junk) throw new Error(junk);
		return parsed;
	});
	return { findings, coverage: text(row.coverage) };
}

export interface Reverify {
	verdict: "verified" | "corrected" | "rejected";
	reason: string;
	evidence: Citation[];
	missingContext: string[];
}

export function parseReverify(value: unknown, snapshot: Snapshot): Reverify {
	const row = object(value, ["verdict", "reason", "evidence", "missingContext"]);
	const verdict = row.verdict;
	if (verdict !== "verified" && verdict !== "corrected" && verdict !== "rejected") throw new Error("Invalid reverify");
	return {
		verdict,
		reason: text(row.reason),
		evidence: citations(row.evidence, snapshot, true),
		missingContext: texts(row.missingContext, true),
	};
}

export function parseVerdict(value: unknown, snapshot: Snapshot): Verdict {
	const row = object(value, ["verdict", "reason", "evidence", "missingContext"]);
	const verdict = row.verdict;
	if (verdict !== "supported" && verdict !== "rejected" && verdict !== "needs-context")
		throw new Error("Invalid verdict");
	const missingContext = texts(row.missingContext, true);
	if (verdict === "supported" && missingContext.length) throw new Error("Supported verdict has unresolved context");
	if (verdict === "needs-context" && !missingContext.length) throw new Error("Missing context must be named");
	return {
		verdict,
		reason: text(row.reason),
		evidence: citations(row.evidence, snapshot, verdict !== "supported"),
		missingContext,
	};
}

export interface DedupMerge {
	canonicalId: string;
	duplicateIds: string[];
	reason: string;
}

export function parseDedup(value: unknown): { merges: DedupMerge[] } {
	const row = object(value, ["merges"]);
	if (!Array.isArray(row.merges) || row.merges.length > 40) throw new Error("Invalid merges list");
	return {
		merges: row.merges.map((item) => {
			const merge = object(item, ["canonicalId", "duplicateIds", "reason"]);
			if (!Array.isArray(merge.duplicateIds) || merge.duplicateIds.length > 40) {
				throw new Error("Invalid duplicateIds");
			}
			return {
				canonicalId: text(merge.canonicalId),
				duplicateIds: merge.duplicateIds.map(text),
				reason: text(merge.reason),
			};
		}),
	};
}

export function findingId(finding: Finding): string {
	// Exact-root-cause grouping must not erase defects merely because they share a location.
	return createHash("sha256")
		.update(
			JSON.stringify([
				finding.rootCause.trim(),
				finding.trustBoundary.trim(),
				finding.evidence.map(({ path, startLine, endLine }) => [path, startLine, endLine]).sort(),
			]),
		)
		.digest("hex")
		.slice(0, 24);
}

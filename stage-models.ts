import type { ModelRef } from "./scope.ts";

export type PipelineStage =
	| "recon"
	| "hunt"
	| "validate"
	| "gapfill"
	| "trace"
	| "feedback"
	| "reverify"
	| "vvs-dedup"
	| "vvs-judgment"
	| "vvs-fixing"
	| "fizz";
export type ModelRole = "recon" | "hunter" | "validator";

export interface CatalogModel {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface StageModelSelection {
	stage: PipelineStage;
	role: ModelRole;
	model: ModelRef;
}

/**
 * Fixed role identities. secgin no longer calls provider models; the driving agent
 * fulfils every role itself. recon/hunter/validator stay distinct so the pipeline keeps
 * asking the agent (ideally a fresh sub-agent) for an independent validation read.
 */
export const ROLE_MODELS: Record<ModelRole, ModelRef> = {
	recon: { provider: "agent", id: "recon" },
	hunter: { provider: "agent", id: "hunter" },
	validator: { provider: "agent", id: "validator" },
};

export function sameModel(left: ModelRef, right: ModelRef): boolean {
	return left.provider === right.provider && left.id === right.id;
}

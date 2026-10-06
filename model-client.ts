import { AgentClient } from "./agent-client.ts";
import { MiniMaxClient } from "./minimax-client.ts";
import { OpenAIClient } from "./openai-client.ts";
import type { ModelClient, ModelRequest, ModelResponse } from "./runner.ts";
import type { HarnessConfig, ModelRef } from "./scope.ts";

function narrowConfig(config: HarnessConfig, providers: string[]): HarnessConfig {
	const models: Record<string, ModelRef> = {};
	for (const [role, ref] of Object.entries(config.models)) {
		if (providers.includes(ref.provider)) models[role] = ref;
	}
	return { ...config, models };
}

export function allModels(env?: NodeJS.ProcessEnv): { provider: string; id: string; contextWindow: number; maxTokens: number }[] {
	const models = [...new MiniMaxClient({ env }).listModels(), ...new OpenAIClient({ env }).listModels()];
	if ((env ?? process.env).SECGIN_AGENT_DIR?.trim()) {
		models.push({ provider: "agent", id: "coding-agent", contextWindow: 1_000_000, maxTokens: 100_000 });
	}
	return models;
}

export class MultiProviderClient implements ModelClient {
	private authorized = false;
	private readonly env: NodeJS.ProcessEnv;
	private minimaxClient?: MiniMaxClient;
	private openaiClient?: OpenAIClient;
	private agentClient?: AgentClient;

	constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
		this.env = options.env ?? process.env;
	}

	private minimax(): MiniMaxClient {
		if (!this.minimaxClient) this.minimaxClient = new MiniMaxClient({ env: this.env });
		return this.minimaxClient;
	}

	private openai(): OpenAIClient {
		if (!this.openaiClient) this.openaiClient = new OpenAIClient({ env: this.env });
		return this.openaiClient;
	}

	private agent(): AgentClient {
		if (!this.agentClient) this.agentClient = new AgentClient({ env: this.env });
		return this.agentClient;
	}

	listModels(): { provider: string; id: string; contextWindow: number; maxTokens: number }[] {
		return allModels(this.env);
	}

	async preflight(config: HarnessConfig): Promise<void> {
		this.authorized = false;
		if (!config.authorization.allowRemoteModels) throw new Error("Remote model transmission is not authorized");
		if (Date.parse(config.authorization.expiresAt) <= Date.now()) throw new Error("Authorization expired");
		const providers = new Set(Object.values(config.models).map((ref) => ref.provider));
		if (providers.has("minimax") || providers.has("minimax-cn")) {
			await this.minimax().preflight(narrowConfig(config, ["minimax", "minimax-cn"]));
		}
		if (providers.has("openai")) {
			await this.openai().preflight(narrowConfig(config, ["openai"]));
		}
		if (providers.has("agent")) {
			await this.agent().preflight(narrowConfig(config, ["agent"]));
		}
		this.authorized = true;
	}

	async authorize(ref: ModelRef, config: HarnessConfig): Promise<void> {
		if (!this.authorized) throw new Error("Remote model preflight is required");
		if (ref.provider === "minimax" || ref.provider === "minimax-cn") return this.minimax().authorize(ref, config);
		if (ref.provider === "openai") return this.openai().authorize(ref, config);
		if (ref.provider === "agent") return this.agent().authorize(ref);
		throw new Error("Unknown provider");
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		if (request.model.provider === "minimax" || request.model.provider === "minimax-cn") return this.minimax().complete(request);
		if (request.model.provider === "openai") return this.openai().complete(request);
		if (request.model.provider === "agent") return this.agent().complete(request);
		throw new Error("Unknown provider");
	}
}

export function createClient(_config: HarnessConfig, env?: NodeJS.ProcessEnv): ModelClient {
	return new MultiProviderClient({ env });
}

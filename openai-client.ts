import { env } from "node:process";
import type { ModelClient, ModelRequest, ModelResponse } from "./runner.ts";
import type { HarnessConfig, ModelRef } from "./scope.ts";
import type { CatalogEntry } from "./minimax-client.ts";

export interface OpenAIClientOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

const DEFAULT_BASE = "https://api.openai.com/v1";

const OPENAI_MODELS: Omit<CatalogEntry, "provider" | "baseUrl">[] = [
	{ id: "gpt-4o", contextWindow: 128000, maxTokens: 16384 },
	{ id: "gpt-4o-mini", contextWindow: 128000, maxTokens: 16384 },
	{ id: "o3-mini", contextWindow: 200000, maxTokens: 100000 },
	{ id: "o1-mini", contextWindow: 128000, maxTokens: 65536 },
];

function catalog(baseUrl: string): CatalogEntry[] {
	return OPENAI_MODELS.map((model) => ({ ...model, provider: "openai", baseUrl }));
}

export class OpenAIClient implements ModelClient {
	private authorized = false;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly models: CatalogEntry[];

	constructor(options: OpenAIClientOptions = {}) {
		this.env = options.env ?? env;
		this.fetchImpl = options.fetch ?? fetch;
		this.baseUrl = this.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE;
		this.models = catalog(this.baseUrl);
	}

	listModels(): { provider: string; id: string; contextWindow: number; maxTokens: number }[] {
		return this.models.map(({ provider, id, contextWindow, maxTokens }) => ({
			provider,
			id,
			contextWindow,
			maxTokens,
		}));
	}

	async preflight(config: HarnessConfig): Promise<void> {
		this.authorized = false;
		if (!config.authorization.allowRemoteModels) throw new Error("Remote model transmission is not authorized");
		if (Date.parse(config.authorization.expiresAt) <= Date.now()) throw new Error("Authorization expired");
		for (const ref of Object.values(config.models)) this.assertUsable(ref, config);
		this.authorized = true;
	}

	async authorize(ref: ModelRef, _config: HarnessConfig): Promise<void> {
		if (!this.authorized) throw new Error("Remote model preflight is required");
		if (this.findModel(ref)) return;
		throw new Error("Configured model is absent from the installed catalog; use the models command");
	}

	private findModel(ref: ModelRef): CatalogEntry | undefined {
		return this.models.find((model) => model.provider === ref.provider && model.id === ref.id);
	}

	private apiKey(): string | undefined {
		return this.env.OPENAI_API_KEY?.trim() || undefined;
	}

	private isLocal(): boolean {
		return this.baseUrl.startsWith("http://localhost") || this.baseUrl.startsWith("http://127.0.0.1");
	}

	private assertUsable(ref: ModelRef, config: HarnessConfig): void {
		if (!config.authorization.allowRemoteModels) throw new Error("Remote model transmission is not authorized");
		const model = this.findModel(ref);
		if (!model) throw new Error("Configured model is absent from the installed catalog; use the models command");
		if (config.limits.maxOutputTokens > model.maxTokens) throw new Error("Output budget exceeds model capability");
		if (!this.isLocal() && !this.apiKey()) throw new Error("A configured model provider has no credentials");
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		if (!this.authorized) throw new Error("Remote model preflight is required");
		const model = this.findModel(request.model);
		if (!model) throw new Error("Unknown model");
		const key = this.apiKey();
		const inputBound = Buffer.byteLength(request.system + request.prompt, "utf8") + 8192;
		if (inputBound + request.maxOutputTokens > model.contextWindow) throw new Error("Model context budget exceeded");
		const endpoint = this.baseUrl.endsWith("/v1")
			? `${this.baseUrl}/chat/completions`
			: `${this.baseUrl}/v1/chat/completions`;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (key) headers["authorization"] = `Bearer ${key}`;
		const messages: { role: string; content: string }[] = [];
		if (request.system) messages.push({ role: "system", content: request.system });
		messages.push({ role: "user", content: request.prompt });
		const response = await this.fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model.id,
				max_tokens: request.maxOutputTokens,
				messages,
			}),
			signal: request.signal,
		});
		const body = await response.text();
		if (!response.ok) throw new Error("Incomplete, failed or tool-bearing model response");
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error("Incomplete, failed or tool-bearing model response");
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("Incomplete, failed or tool-bearing model response");
		}
		const payload = parsed as {
			error?: { message?: unknown };
			choices?: { message?: { content?: unknown; role?: unknown } }[];
			usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
		};
		if (payload.error) throw new Error("Incomplete, failed or tool-bearing model response");
		if (!Array.isArray(payload.choices) || !payload.choices.length) {
			throw new Error("Incomplete, failed or tool-bearing model response");
		}
		const content = payload.choices[0]?.message?.content;
		if (typeof content !== "string") throw new Error("Incomplete, failed or tool-bearing model response");
		const inputTokens = typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : 0;
		const outputTokens = typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : 0;
		return { text: content, inputTokens, outputTokens };
	}
}

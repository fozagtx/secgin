import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "./runner.ts";
import type { HarnessConfig, ModelRef } from "./scope.ts";

export interface CatalogEntry {
	provider: string;
	id: string;
	contextWindow: number;
	maxTokens: number;
	baseUrl: string;
}

export interface MiniMaxClientOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	readFile?: (path: string) => string | undefined;
	homedir?: string;
}

const GLOBAL_BASE = "https://api.minimax.io/anthropic";
const CN_BASE = "https://api.minimaxi.com/anthropic";

const MINIMAX_MODELS: Omit<CatalogEntry, "provider" | "baseUrl">[] = [
	{ id: "MiniMax-M2.7", contextWindow: 200000, maxTokens: 128000 },
	{ id: "MiniMax-M2.7-highspeed", contextWindow: 200000, maxTokens: 128000 },
	{ id: "MiniMax-M3", contextWindow: 512000, maxTokens: 128000 },
];

function envVarFor(provider: string): string {
	return provider === "minimax-cn" ? "MINIMAX_CN_API_KEY" : "MINIMAX_API_KEY";
}

function catalog(): CatalogEntry[] {
	return [
		...MINIMAX_MODELS.map((model) => ({ ...model, provider: "minimax", baseUrl: GLOBAL_BASE })),
		...MINIMAX_MODELS.map((model) => ({ ...model, provider: "minimax-cn", baseUrl: CN_BASE })),
	];
}

function readConfigApiKey(
	readFile: (path: string) => string | undefined,
	home: string,
	dataDirEnv?: string,
): string | undefined {
	const candidates = [
		dataDirEnv ? join(dataDirEnv, "config.yaml") : undefined,
		join(home, ".minimax-code", "config.yaml"),
		join(home, ".minimax", "config.yaml"),
	].filter((path): path is string => Boolean(path));
	for (const path of candidates) {
		const text = readFile(path);
		if (!text) continue;
		const block = /minimax_api:\s*\n((?:[ \t]+[^\n]*\n)+)/.exec(text);
		const key = (block?.[1] ?? text).match(/(?:^|\n)[ \t]*apiKey:\s*["']?([^\s"']+)/)?.[1];
		if (key) return key;
	}
	return undefined;
}

function defaultReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export class MiniMaxClient implements ModelClient {
	private authorized = false;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly readFile: (path: string) => string | undefined;
	private readonly home: string;
	private readonly models = catalog();

	constructor(options: MiniMaxClientOptions = {}) {
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetch ?? fetch;
		this.readFile = options.readFile ?? defaultReadFile;
		this.home = options.homedir ?? homedir();
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

	async authorize(ref: ModelRef, config: HarnessConfig): Promise<void> {
		if (!this.authorized) throw new Error("Remote model preflight is required");
		this.assertUsable(ref, config);
	}

	private findModel(ref: ModelRef): CatalogEntry | undefined {
		return this.models.find((model) => model.provider === ref.provider && model.id === ref.id);
	}

	private apiKey(provider: string): string | undefined {
		if (provider === "minimax") {
			return this.env.MINIMAX_API_KEY?.trim() || this.configKey();
		}
		if (provider === "minimax-cn") {
			return this.env.MINIMAX_CN_API_KEY?.trim() || this.env.MINIMAX_API_KEY?.trim() || this.configKey();
		}
		return undefined;
	}

	private configKey(): string | undefined {
		return readConfigApiKey(this.readFile, this.home, this.env.MINIMAX_DATA_DIR?.trim());
	}

	private assertUsable(ref: ModelRef, config: HarnessConfig): void {
		if (!config.authorization.allowRemoteModels) throw new Error("Remote model transmission is not authorized");
		const model = this.findModel(ref);
		if (!model) throw new Error("Configured model is absent from the installed catalog; use the models command");
		if (config.limits.maxOutputTokens > model.maxTokens) throw new Error("Output budget exceeds model capability");
		if (!this.apiKey(ref.provider)) {
			throw new Error(
				`No credentials for provider ${ref.provider}: set ${envVarFor(ref.provider)} or apiKey in ~/.minimax-code/config.yaml`,
			);
		}
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		if (!this.authorized) throw new Error("Remote model preflight is required");
		const model = this.findModel(request.model);
		if (!model) throw new Error("Unknown model");
		const key = this.apiKey(request.model.provider);
		if (!key) {
			throw new Error(
				`No credentials for provider ${request.model.provider}: set ${envVarFor(request.model.provider)} or apiKey in ~/.minimax-code/config.yaml`,
			);
		}
		const inputBound = Buffer.byteLength(request.system + request.prompt, "utf8") + 8192;
		if (inputBound + request.maxOutputTokens > model.contextWindow) throw new Error("Model context budget exceeded");
		const response = await this.fetchImpl(`${model.baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": key,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: model.id,
				max_tokens: request.maxOutputTokens,
				system: request.system,
				messages: [{ role: "user", content: request.prompt }],
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
			type?: unknown;
			stop_reason?: unknown;
			content?: unknown;
			usage?: { input_tokens?: unknown; output_tokens?: unknown };
		};
		if (payload.type === "error") throw new Error("Incomplete, failed or tool-bearing model response");
		if (payload.stop_reason !== "end_turn") throw new Error("Incomplete, failed or tool-bearing model response");
		if (!Array.isArray(payload.content)) throw new Error("Incomplete, failed or tool-bearing model response");
		const textParts: string[] = [];
		for (const part of payload.content) {
			if (typeof part !== "object" || part === null) {
				throw new Error("Incomplete, failed or tool-bearing model response");
			}
			const item = part as { type?: unknown; text?: unknown };
			if (item.type === "tool_use") throw new Error("Incomplete, failed or tool-bearing model response");
			if (item.type === "text" && typeof item.text === "string") textParts.push(item.text);
		}
		const inputTokens = typeof payload.usage?.input_tokens === "number" ? payload.usage.input_tokens : 0;
		const outputTokens = typeof payload.usage?.output_tokens === "number" ? payload.usage.output_tokens : 0;
		return { text: textParts.join(""), inputTokens, outputTokens };
	}
}

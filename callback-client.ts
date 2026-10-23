import { randomUUID } from "node:crypto";
import type { ModelClient, ModelRequest, ModelResponse } from "./runner.ts";

export interface PendingPrompt {
	id: string;
	role: string;
	system: string;
	prompt: string;
	maxOutputTokens: number;
}

interface Waiter {
	resolve: (response: ModelResponse) => void;
	reject: (error: Error) => void;
}

/**
 * A ModelClient that never calls a provider. Each complete() parks the prompt in an
 * outbox and returns a promise; the driving agent reads the outbox (harness_next),
 * reasons about each prompt itself, and hands the answers back (harness_submit), which
 * resolves the parked promises. This is how secgin runs the whole VDH/VVS pipeline with
 * the host agent as the only model — no API keys, nothing leaves the machine.
 */
export class CallbackClient implements ModelClient {
	private readonly waiters = new Map<string, Waiter>();
	private readonly queued = new Map<string, PendingPrompt>();
	private notify: (() => void) | null = null;

	complete(request: ModelRequest): Promise<ModelResponse> {
		const id = randomUUID();
		const role = request.model.id;
		this.queued.set(id, {
			id,
			role,
			system: request.system,
			prompt: request.prompt,
			maxOutputTokens: request.maxOutputTokens,
		});
		const promise = new Promise<ModelResponse>((resolve, reject) => {
			this.waiters.set(id, { resolve, reject });
		});
		if (request.signal) {
			const onAbort = () => this.reject(id, new Error("timeout"));
			if (request.signal.aborted) onAbort();
			else request.signal.addEventListener("abort", onAbort, { once: true });
		}
		this.notify?.();
		return promise;
	}

	/** Prompts the agent has not yet been handed, in insertion order. */
	outbox(): PendingPrompt[] {
		return [...this.queued.values()];
	}

	/** Number of prompts awaiting an agent answer (queued + delivered-but-unanswered). */
	get inFlight(): number {
		return this.waiters.size;
	}

	/** Deliver one agent answer. Returns false if the id is unknown or already answered. */
	submit(id: string, text: string): boolean {
		const waiter = this.waiters.get(id);
		if (!waiter) return false;
		this.waiters.delete(id);
		this.queued.delete(id);
		waiter.resolve({ text, inputTokens: 0, outputTokens: 0 });
		return true;
	}

	private reject(id: string, error: Error): void {
		const waiter = this.waiters.get(id);
		if (!waiter) return;
		this.waiters.delete(id);
		this.queued.delete(id);
		waiter.reject(error);
	}

	/** Register a callback fired whenever a new prompt is parked. */
	onPrompt(callback: (() => void) | null): void {
		this.notify = callback;
	}
}

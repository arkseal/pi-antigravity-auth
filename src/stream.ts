/**
 * Custom streamSimple implementation for the Antigravity provider.
 *
 * Flow:
 *   pi Context -> Gemini-style request -> Antigravity envelope -> SSE POST
 *   SSE chunks (unwrapped from { response }) -> AssistantMessageEvents
 *
 * Includes multi-account rotation on 429 rate limits, ported (simplified)
 * from opencode-antigravity-auth-updated/src/plugin.ts.
 */
import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { ANTIGRAVITY_DEFAULT_PROJECT_ID as DEFAULT_PROJECT_ID, ANTIGRAVITY_ENDPOINT, getRandomizedAntigravityHeaders } from "./constants.js";
import { createToolNameMap, convertMessages, convertTools } from "./convert.js";
import { resolveBackendModel } from "./models.js";
import { describeAccount, getAllAccounts, getAccessToken, markHealthy, markRateLimited, selectAccount, selectInitialAccount, type PoolAccount } from "./accounts.js";
import { extractRateLimitInfo, formatWaitTime } from "./ratelimit.js";

const PROVIDER_ID = "antigravity";
const MAX_WAIT_FOR_RESET_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface AntigravityEnvelope {
	project: string;
	model: string;
	request: Record<string, unknown>;
	userAgent: string;
	requestId: string;
}

let requestCounter = 0;

function buildEnvelope(projectId: string, backendModel: string, request: Record<string, unknown>): AntigravityEnvelope {
	return {
		project: projectId,
		model: backendModel,
		request,
		userAgent: "antigravity",
		requestId: `pi-${Date.now().toString(36)}-${(requestCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	};
}

// ---------------------------------------------------------------------------
// SSE handling
// ---------------------------------------------------------------------------

async function* iterateSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				if (line.startsWith("data:")) {
					yield line.slice(5).trim();
				}
			}
		}
		const tail = buffer.trim();
		if (tail.startsWith("data:")) yield tail.slice(5).trim();
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// Response part -> event processing (mirrors pi-ai's google adapter)
// ---------------------------------------------------------------------------

interface StreamChunk {
	response?: {
		candidates?: Array<{
			content?: { parts?: Array<Record<string, unknown>> };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			cachedContentTokenCount?: number;
			totalTokenCount?: number;
		};
		modelVersion?: string;
	};
	error?: { code?: number; message?: string; status?: string };
}

function mapFinishReason(reason: string): "stop" | "length" | "error" {
	if (reason === "STOP") return "stop";
	if (reason === "MAX_TOKENS") return "length";
	return "error";
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

export const ANTIGRAVITY_API_ID = "antigravity-gemini";

export function streamAntigravity(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// --- Resolve accounts ---------------------------------------------
			const accounts = getAllAccounts(PROVIDER_ID);
			if (accounts.length === 0) {
				throw new Error(
					"Not authenticated with Antigravity. Run `/login antigravity` in pi to sign in with your Google account.",
				);
			}

			let startIndex = selectInitialAccount(accounts);
			if (startIndex < 0 && accounts.length > 0) {
				// All accounts are currently rate-limited: wait for the earliest reset.
				const { soonestResetMs } = selectAccount(accounts, 0);
				await waitForResetOrThrow(soonestResetMs, options?.signal);
				startIndex = selectInitialAccount(accounts);
			}
			if (startIndex < 0) {
				throwAllBlockedError(accounts);
			}
			if (accounts.length > 1) {
				// Rotate start position so parallel sessions spread across accounts.
				startIndex = (startIndex + rotationOffset()) % accounts.length;
			}

			// --- Build the request payload once -------------------------------
			const nameMap = createToolNameMap(context.tools);
			const toWireName = (realName: string): string => {
				for (const [wire, real] of nameMap) if (real === realName) return wire;
				return realName;
			};
			const toRealName = (wireName: string): string => nameMap.get(wireName) ?? wireName;

			// options.reasoning is falsy/absent when thinking is disabled.
			const thinkingRequested = Boolean(options?.reasoning);
			const resolved = resolveBackendModel(model.id, options?.reasoning);
			const contents = convertMessages({ id: model.id, provider: model.provider }, context.messages as never, toRealName, toWireName);

			const generationConfig: Record<string, unknown> = {};
			generationConfig.maxOutputTokens =
				options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : model.maxTokens;
			if (options?.temperature !== undefined) {
				generationConfig.temperature = options.temperature;
			}
			if (model.reasoning && thinkingRequested) {
				const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
				if (resolved.thinkingLevel !== undefined) {
					thinkingConfig.thinkingLevel = String(resolved.thinkingLevel).toUpperCase();
				} else if (resolved.thinkingBudget !== undefined) {
					thinkingConfig.thinkingBudget = resolved.thinkingBudget;
				}
				generationConfig.thinkingConfig = thinkingConfig;
			}

			const request: Record<string, unknown> = { contents };
			if (context.systemPrompt) {
				request.systemInstruction = { parts: [{ text: context.systemPrompt }] };
			}
			if (context.tools && context.tools.length > 0) {
				const tools = convertTools(context.tools as never, toWireName);
				if (tools) request.tools = tools;
			}
			request.generationConfig = generationConfig;

			// --- Send with account rotation ------------------------------------
			stream.push({ type: "start", partial: output });

			let accountIndex = startIndex;
			let lastError: Error | null = null;

			const maxRounds = Math.min(accounts.length * 2 + 2, 12);
			for (let round = 0; round < maxRounds; round++) {
				const account = accounts[accountIndex]!;
				let accessToken: string;
				let projectId: string | undefined;

				try {
					const tokenResult = await getAccessToken(account, options?.signal);
					accessToken = tokenResult.accessToken;
					projectId = tokenResult.projectId;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					// Unrecoverable for this account (e.g. revoked token): block it and rotate.
					markRateLimited(account, Date.now() + 10 * 60_000);
					const next = selectAccount(accounts, accountIndex);
					if (next.index < 0) throw lastError;
					accountIndex = next.index;
					continue;
				}

				let envelope = buildEnvelope(projectId || DEFAULT_PROJECT_ID, resolved.model, request);
				if (options?.onPayload) {
					const replacement = await options.onPayload(envelope, model);
					if (replacement !== undefined && replacement !== null) {
						envelope = replacement as typeof envelope;
					}
				}
				const headers = {
					...getRandomizedAntigravityHeaders(),
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				};

				const controller = new AbortController();
				const onAbort = () => controller.abort(options?.signal?.reason);
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), REQUEST_TIMEOUT_MS);

				let response: Response;
				try {
					response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
						method: "POST",
						headers,
						body: JSON.stringify(envelope),
						signal: controller.signal,
					});
				} catch (error) {
					clearTimeout(timeout);
					options?.signal?.removeEventListener("abort", onAbort);
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					throw error instanceof Error ? error : new Error(String(error));
				}

				if (options?.onResponse) {
					const responseHeaders: Record<string, string> = {};
					response.headers.forEach((value, key) => {
						responseHeaders[key] = value;
					});
					await options.onResponse({ status: response.status, headers: responseHeaders }, model);
				}

				if (!response.ok) {
					clearTimeout(timeout);
					options?.signal?.removeEventListener("abort", onAbort);
					const bodyText = await response.text().catch(() => "");
					let parsedBody: unknown;
					try {
						parsedBody = JSON.parse(bodyText);
					} catch {
						parsedBody = null;
					}

					if (response.status === 429 || response.status === 503) {
						const info = extractRateLimitInfo(parsedBody);
						const waitMs = info.retryDelayMs ?? 60_000;
						markRateLimited(account, Date.now() + waitMs + 1000);
						lastError = new Error(
							`Rate limited on ${describeAccount(account, accountIndex)} — quota resets in ${formatWaitTime(waitMs)}.`,
						);
						const next = selectAccount(accounts, accountIndex);
						if (next.index < 0) {
							await waitForResetOrThrow(next.soonestResetMs, options?.signal);
							const retried = selectInitialAccount(accounts);
							if (retried < 0) throw lastError;
							accountIndex = retried;
							continue;
						}
						accountIndex = next.index;
						continue;
					}

					// Non-retryable HTTP error.
					const message =
						(parsedBody && typeof parsedBody === "object" && extractErrorMessage(parsedBody)) ??
						bodyText.slice(0, 500) ??
						`${response.status} ${response.statusText}`;
					throw new Error(`Antigravity API error (${response.status}): ${message}`);
				}

				// --- Stream the response ------------------------------------------
				try {
					await consumeStream(response, output, stream, model, toRealName, options?.signal);
				} finally {
					clearTimeout(timeout);
					options?.signal?.removeEventListener("abort", onAbort);
				}
				markHealthy(account);

				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (output.stopReason === "pending") {
					throw new Error("Antigravity stream ended without a finish reason");
				}
				if (output.stopReason === "aborted" || output.stopReason === "error") {
					throw new Error(output.errorMessage ?? "An unknown error occurred");
				}

				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end();
				return;
			}

			throw lastError ?? new Error("Antigravity request failed after all retries");
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Helpers shared with the main flow
// ---------------------------------------------------------------------------

let sessionRotationCounter = 0;

function rotationOffset(): number {
	return sessionRotationCounter++ % 64;
}

function extractErrorMessage(body: unknown): string | undefined {
	const error = (body as { error?: { message?: string } }).error;
	return typeof error?.message === "string" ? error.message : undefined;
}

function throwAllBlockedError(accounts: PoolAccount[]): never {
	throw new Error(
		`All ${accounts.length} Antigravity account(s) are currently rate-limited. Try again later.`,
	);
}

async function waitForResetOrThrow(resetMs: number, signal?: AbortSignal): Promise<void> {
	const waitMs = Math.min(resetMs - Date.now(), MAX_WAIT_FOR_RESET_MS);
	if (waitMs <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, waitMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Consume the SSE response body and push events into the output stream.
 */
async function consumeStream(
	response: Response,
	output: AssistantMessage,
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model<Api>,
	toRealName: (wireName: string) => string,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) throw new Error("Antigravity response has no body");

	type TextBlock = { type: "text"; text: string };
	type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string };
	let currentBlock: TextBlock | ThinkingBlock | null = null;
	let toolCallCounter = 0;
	let sawFinish = false;

	const closeCurrentBlock = () => {
		if (!currentBlock) return;
		const index = output.content.length - 1;
		if (currentBlock.type === "text") {
			stream.push({ type: "text_end", contentIndex: index, content: currentBlock.text, partial: output });
		} else {
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: currentBlock.thinking,
				partial: output,
			});
		}
		currentBlock = null;
	};

	for await (const data of iterateSse(response.body, signal)) {
		if (!data || data === "[DONE]") continue;

		let chunk: StreamChunk;
		try {
			chunk = JSON.parse(data) as StreamChunk;
		} catch {
			continue; // Skip malformed lines.
		}

		if (chunk.error) {
			throw new Error(chunk.error.message ?? chunk.error.status ?? "Unknown Antigravity API error");
		}

		const candidate = chunk.response?.candidates?.[0];

		for (const part of candidate?.content?.parts ?? []) {
			const text = typeof part.text === "string" ? part.text : undefined;
			const functionCall = part.functionCall as
				| { name?: string; args?: Record<string, unknown>; id?: string }
				| undefined;

			if (text !== undefined) {
				const isThinking = part.thought === true;
				const signature = typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;

				if (
					!currentBlock ||
					currentBlock.type !== (isThinking ? "thinking" : "text")
				) {
					closeCurrentBlock();
					// Push the SAME object we keep mutating so output.content stays in sync.
					currentBlock = isThinking
						? { type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) }
						: { type: "text", text: "" };
					output.content.push(currentBlock);
					stream.push(
						isThinking
							? { type: "thinking_start", contentIndex: output.content.length - 1, partial: output }
							: { type: "text_start", contentIndex: output.content.length - 1, partial: output },
					);
				}

				if (currentBlock.type === "thinking") {
					if (signature) currentBlock.thinkingSignature = signature;
					currentBlock.thinking += text;
					stream.push({
						type: "thinking_delta",
						contentIndex: output.content.length - 1,
						delta: text,
						partial: output,
					});
				} else {
					currentBlock.text += text;
					stream.push({
						type: "text_delta",
						contentIndex: output.content.length - 1,
						delta: text,
						partial: output,
					});
				}
			} else if (functionCall?.name) {
				closeCurrentBlock();

				const toolCallId = functionCall.id || `${functionCall.name}_${Date.now()}_${++toolCallCounter}`;
				const toolCall = {
					type: "toolCall" as const,
					id: toolCallId,
					name: toRealName(functionCall.name),
					arguments: functionCall.args ?? {},
					...(typeof part.thoughtSignature === "string" && part.thoughtSignature
						? { thoughtSignature: part.thoughtSignature }
						: {}),
				};
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: output.content.length - 1,
					delta: JSON.stringify(toolCall.arguments),
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall, partial: output });
			}
		}

		if (candidate?.finishReason) {
			sawFinish = true;
			const mapped = mapFinishReason(candidate.finishReason);
			output.rawStopReason = candidate.finishReason;
			if (mapped === "stop" && output.content.some((b) => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			} else if (mapped === "error") {
				output.stopReason = "error";
				output.errorMessage = `Provider stopped with: ${candidate.finishReason}`;
			} else {
				output.stopReason = mapped;
			}
		}

		const usage = chunk.response?.usageMetadata;
		if (usage) {
			const cachedRead = usage.cachedContentTokenCount ?? 0;
			output.usage = {
				input: Math.max(0, (usage.promptTokenCount ?? 0) - cachedRead),
				output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
				cacheRead: cachedRead,
				cacheWrite: 0,
				totalTokens: usage.totalTokenCount ?? 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			calculateCost(model, output.usage);
		}
	}

	closeCurrentBlock();

	if (!sawFinish && output.stopReason === "pending") {
		throw new Error("Antigravity stream ended without a finish reason");
	}
}

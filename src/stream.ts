/**
 * Custom streamSimple implementation for the Antigravity provider.
 *
 * Flow:
 *   pi Context -> Gemini-style request -> Antigravity envelope -> SSE POST
 *   SSE chunks (unwrapped from { response }) -> MathStreamBuffer -> AssistantMessageEvents
 *
 * Includes multi-account rotation on 429 rate limits, health tracking,
 * device fingerprinting, and LaTeX math formatting.
 * Ported from opencode-antigravity-auth-updated.
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

import {
	ANTIGRAVITY_DEFAULT_PROJECT_ID as DEFAULT_PROJECT_ID,
	ANTIGRAVITY_ENDPOINT,
	getRandomizedAntigravityHeaders,
} from "./constants.js";
import {
	createToolNameMap,
	convertMessages,
	convertTools,
	buildSystemInstruction,
} from "./convert.js";
import { resolveBackendModel, isClaudeModel, isClaudeThinkingModel } from "./model-resolver.js";
import {
	getAccountManager,
	parseRateLimitReason,
	type ManagedAccount,
} from "./accounts.js";
import { buildFingerprintHeaders } from "./fingerprint.js";
import { configureClaudeToolConfig } from "./transform/claude.js";
import { buildImageGenerationConfig } from "./transform/gemini.js";
import {
	analyzeConversationState,
	needsThinkingRecovery,
	closeToolLoopForThinking,
} from "./transform/thinking-recovery.js";
import { MathStreamBuffer } from "./math/stream-buffer.js";
import { parseDurationToMs, formatWaitTime } from "./logging-utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("stream");

export const ANTIGRAVITY_API_ID = "antigravity-gemini";
const MAX_WAIT_FOR_RESET_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

interface AntigravityEnvelope {
	project: string;
	model: string;
	request: Record<string, unknown>;
	userAgent: string;
	requestId: string;
}

let requestCounter = 0;

function buildEnvelope(
	projectId: string,
	backendModel: string,
	request: Record<string, unknown>,
): AntigravityEnvelope {
	return {
		project: projectId,
		model: backendModel,
		request,
		userAgent: "antigravity",
		requestId: `pi-${Date.now().toString(36)}-${(requestCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	};
}

async function* iterateSse(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<string> {
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
	error?: { code?: number; message?: string; status?: string; details?: unknown[] };
}

function mapFinishReason(reason: string): "stop" | "length" | "error" {
	if (reason === "STOP") return "stop";
	if (reason === "MAX_TOKENS") return "length";
	return "error";
}

function extractRateLimitInfo(body: unknown): { retryDelayMs: number | null; message?: string } {
	if (!body || typeof body !== "object") return { retryDelayMs: null };
	const error = (body as { error?: unknown }).error;
	if (!error || typeof error !== "object") return { retryDelayMs: null };

	const rawMessage = (error as { message?: unknown }).message;
	const message = typeof rawMessage === "string" ? rawMessage : undefined;

	const details = (error as { details?: unknown[] }).details;
	if (Array.isArray(details)) {
		for (const detail of details) {
			if (!detail || typeof detail !== "object") continue;
			const type = (detail as { "@type"?: string })["@type"];
			if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
				const retryDelay = (detail as { retryDelay?: string }).retryDelay;
				if (typeof retryDelay === "string") {
					const ms = parseDurationToMs(retryDelay);
					if (ms !== null) return { retryDelayMs: ms, message };
				}
			}
		}
	}

	if (message) {
		const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
		if (afterMatch?.[1]) {
			const parsed = parseDurationToMs(afterMatch[1]);
			if (parsed !== null) return { retryDelayMs: parsed, message };
		}
	}
	return { retryDelayMs: null, message };
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

function extractErrorMessage(body: unknown): string | undefined {
	const error = (body as { error?: { message?: string } }).error;
	return typeof error?.message === "string" ? error.message : undefined;
}

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
			const accountManager = await getAccountManager();
			const accounts = accountManager.getAccounts();
			if (accounts.length === 0) {
				throw new Error(
					"Not authenticated with Antigravity. Run `/login antigravity` in pi to sign in with your Google account.",
				);
			}

			const nameMap = createToolNameMap(context.tools);
			const toWireName = (realName: string): string => {
				for (const [wire, real] of nameMap) if (real === realName) return wire;
				return realName;
			};
			const toRealName = (wireName: string): string => nameMap.get(wireName) ?? wireName;

			const resolved = resolveBackendModel(model.id, options?.reasoning);
			const isClaude = isClaudeModel(model.id);
			const isClaudeThinking = isClaudeThinkingModel(model.id);
			let contents = convertMessages(
				{ id: model.id, provider: model.provider },
				context.messages as never,
				toRealName,
				toWireName,
			);

			// Proactively recover corrupted thinking state for Claude thinking models
			if (isClaudeThinking && Array.isArray(contents)) {
				const convState = analyzeConversationState(contents);
				if (needsThinkingRecovery(convState)) {
					contents = closeToolLoopForThinking(contents) as typeof contents;
				}
			}

			const generationConfig: Record<string, unknown> = {};
			generationConfig.maxOutputTokens =
				options?.maxTokens && options.maxTokens > 0 ? options.maxTokens : model.maxTokens;
			if (options?.temperature !== undefined) {
				generationConfig.temperature = options.temperature;
			}

			const thinkingRequested = Boolean(options?.reasoning);
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

			const systemInstruction = buildSystemInstruction(
				model.id,
				context.systemPrompt,
				Boolean(context.tools && context.tools.length > 0),
			);
			if (systemInstruction) {
				request.systemInstruction = systemInstruction;
			}

			if (context.tools && context.tools.length > 0) {
				const tools = convertTools(context.tools as never, toWireName);
				if (tools) request.tools = tools;
			}
			request.generationConfig = generationConfig;

			if (isClaude) {
				configureClaudeToolConfig(request);
			}

			if (resolved.isImageModel) {
				request.imageConfig = buildImageGenerationConfig();
			}

			stream.push({ type: "start", partial: output });

			const maxAttempts = Math.min(accounts.length * 2 + 2, 10);
			let lastError: Error | null = null;
			const triedAccountIndices = new Set<number>();

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				let account = accountManager.selectAccount(model.id);
				if (!account) {
					const soonest = accountManager.getSoonestResetTime(isClaude ? "claude" : "gemini");
					if (soonest - Date.now() <= MAX_WAIT_FOR_RESET_MS) {
						await waitForResetOrThrow(soonest, options?.signal);
						account = accountManager.selectAccount(model.id);
					}
				}

				if (!account) {
					if (triedAccountIndices.size === 0) {
						throw new Error(
							"All Antigravity accounts are currently rate-limited or disabled. Try again shortly.",
						);
					}
					break;
				}

				triedAccountIndices.add(account.index);

				let accessToken: string;
				let projectId: string | undefined;

				try {
					const tokenResult = await accountManager.getAccessTokenForAccount(
						account,
						options?.signal,
					);
					accessToken = tokenResult.accessToken;
					projectId = tokenResult.projectId;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					accountManager.recordRateLimit(
						account,
						isClaude ? "claude" : "gemini",
						"UNKNOWN",
						undefined,
						5 * 60 * 1000,
					);
					continue;
				}

				let envelope = buildEnvelope(projectId || DEFAULT_PROJECT_ID, resolved.model, request);
				if (options?.onPayload) {
					const replacement = await options.onPayload(envelope, model);
					if (replacement !== undefined && replacement !== null) {
						envelope = replacement as typeof envelope;
					}
				}

				const headers: Record<string, string> = {
					...getRandomizedAntigravityHeaders(),
					...buildFingerprintHeaders(account.fingerprint ?? null),
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				};

				const controller = new AbortController();
				const onAbort = () => controller.abort(options?.signal?.reason);
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				const timeout = setTimeout(
					() => controller.abort(new Error("Request timed out")),
					REQUEST_TIMEOUT_MS,
				);

				let response: Response;
				try {
					response = await fetch(
						`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
						{
							method: "POST",
							headers,
							body: JSON.stringify(envelope),
							signal: controller.signal,
						},
					);
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

					// 403 Validation Required (re-auth probe needed)
					if (
						response.status === 403 &&
						(bodyText.includes("validation_required") || bodyText.includes("re-authentication"))
					) {
						accountManager.markAccountVerificationRequired(
							account,
							"Account verification required by Google",
						);
						lastError = new Error(
							`Account ${account.email ?? `#${account.index + 1}`} requires verification. Run /antigravity-accounts to check.`,
						);
						continue;
					}

					if (response.status === 429 || response.status === 503 || response.status === 529) {
						const info = extractRateLimitInfo(parsedBody);
						const reason = parseRateLimitReason(undefined, info.message, response.status);
						const backoff = accountManager.recordRateLimit(
							account,
							isClaude ? "claude" : "gemini",
							reason,
							response.status,
							info.retryDelayMs,
						);
						lastError = new Error(
							`Rate limited on ${account.email ?? `account #${account.index + 1}`} — retry in ${formatWaitTime(backoff)}.`,
						);
						continue;
					}

					const message =
						(parsedBody && typeof parsedBody === "object" && extractErrorMessage(parsedBody)) ??
						bodyText.slice(0, 500) ??
						`${response.status} ${response.statusText}`;
					throw new Error(`Antigravity API error (${response.status}): ${message}`);
				}

				// Consume SSE response stream with MathStreamBuffer
				try {
					await consumeStream(response, output, stream, model, toRealName, options?.signal);
					accountManager.recordSuccess(account, isClaude ? "claude" : "gemini");
				} finally {
					clearTimeout(timeout);
					options?.signal?.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (output.stopReason === "pending") {
					throw new Error("Antigravity stream ended without a finish reason");
				}
				if (output.stopReason === "aborted" || output.stopReason === "error") {
					throw new Error(output.errorMessage ?? "An unknown error occurred");
				}

				stream.push({
					type: "done",
					reason: output.stopReason as "stop" | "length" | "toolUse",
					message: output,
				});
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
	const mathBuffer = new MathStreamBuffer();

	const closeCurrentBlock = () => {
		if (!currentBlock) return;
		const index = output.content.length - 1;
		if (currentBlock.type === "text") {
			// Flush math buffer for text block
			if (mathBuffer.hasPending()) {
				const flushed = mathBuffer.flush();
				if (flushed) {
					currentBlock.text += flushed;
					stream.push({
						type: "text_delta",
						contentIndex: index,
						delta: flushed,
						partial: output,
					});
				}
			}
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: currentBlock.text,
				partial: output,
			});
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
			continue;
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
				const signature =
					typeof part.thoughtSignature === "string" && part.thoughtSignature
						? part.thoughtSignature
						: undefined;

				if (!currentBlock || currentBlock.type !== (isThinking ? "thinking" : "text")) {
					closeCurrentBlock();
					currentBlock = isThinking
						? {
								type: "thinking",
								thinking: "",
								...(signature ? { thinkingSignature: signature } : {}),
							}
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
					const processedText = mathBuffer.process(text);
					if (processedText) {
						currentBlock.text += processedText;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.length - 1,
							delta: processedText,
							partial: output,
						});
					}
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
				stream.push({
					type: "toolcall_start",
					contentIndex: output.content.length - 1,
					partial: output,
				});
				stream.push({
					type: "toolcall_delta",
					contentIndex: output.content.length - 1,
					delta: JSON.stringify(toolCall.arguments),
					partial: output,
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.length - 1,
					toolCall,
					partial: output,
				});
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

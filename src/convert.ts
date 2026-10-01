/**
 * Convert pi Context (messages + tools) into the Gemini-style `contents` /
 * `tools` format expected by the Antigravity (Cloud Code Assist) API.
 *
 * Adapted from opencode-antigravity-auth-updated request preparation:
 * - Tools use OpenAPI/Gemini schemas via `toGeminiSchema`
 * - Function names sanitized to Antigravity rules and mapped back on response
 * - Missing/foreign thought signatures on Claude thinking models replaced
 *   with the "skip_thought_signature_validator" sentinel
 * - Tool usage hardening & interleaved thinking hints
 */
import {
	SKIP_THOUGHT_SIGNATURE,
	CLAUDE_TOOL_SYSTEM_INSTRUCTION,
	CLAUDE_INTERLEAVED_THINKING_HINT,
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
} from "./constants.js";
import { isClaudeModel, isClaudeThinkingModel } from "./model-resolver.js";
import { toGeminiSchema } from "./transform/gemini.js";

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

interface SignatureCarrier {
	textSignature?: string;
	thinkingSignature?: string;
	thoughtSignature?: string;
}

function resolveThoughtSignature(
	isSameProviderAndModel: boolean,
	signature: string | undefined,
	requireSentinelFallback: boolean,
): string | undefined {
	if (isSameProviderAndModel && isValidThoughtSignature(signature)) {
		return signature;
	}
	return requireSentinelFallback ? SKIP_THOUGHT_SIGNATURE : undefined;
}

export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	if (major !== undefined) return major >= 3;
	return true;
}

// ---------------------------------------------------------------------------
// Function name sanitization
// ---------------------------------------------------------------------------

const MAX_FUNCTION_NAME_LENGTH = 64;

function sanitizeFunctionName(name: string): string {
	let cleaned = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
	if (!/^[a-zA-Z_]/.test(cleaned)) {
		cleaned = `_${cleaned}`;
	}
	return cleaned.slice(0, MAX_FUNCTION_NAME_LENGTH);
}

export function createToolNameMap(tools: { name: string }[] | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!tools) return map;
	const used = new Set<string>();
	for (const tool of tools) {
		let wire = sanitizeFunctionName(tool.name);
		while (used.has(wire)) {
			const suffix = `_${used.size}`;
			wire = wire.slice(0, Math.max(1, MAX_FUNCTION_NAME_LENGTH - suffix.length)) + suffix;
		}
		used.add(wire);
		map.set(wire, tool.name);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

type WirePart = Record<string, unknown>;
export interface WireContent {
	role: "user" | "model";
	parts: WirePart[];
}

interface PiTextBlock {
	type: "text";
	text: string;
}
interface PiThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}
interface PiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	thoughtSignature?: string;
}
type PiAssistantBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

export interface PiMessageLike {
	role: string;
	content: unknown;
	provider?: string;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export function convertMessages(
	model: { id: string; provider: string },
	messages: PiMessageLike[],
	toRealName: (wireName: string) => string,
	toWireName: (realName: string) => string,
): WireContent[] {
	const contents: WireContent[] = [];
	const needIds = requiresToolCallId(model.id);
	const isClaude = isClaudeModel(model.id);
	const isClaudeThinking = isClaudeThinkingModel(model.id);

	const normalizeToolCallId = (id: string) =>
		needIds ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id;

	for (const msg of messages) {
		if (msg.role === "system") {
			// System instructions are sent via request.systemInstruction for Gemini/Antigravity API.
			continue;
		}
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (!msg.content) continue;
				contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
				continue;
			}
			const parts: WirePart[] = [];
			for (const item of msg.content as Array<{
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
			}>) {
				if (item.type === "text" && item.text) {
					parts.push({ text: sanitizeSurrogates(item.text) });
				} else if (item.type === "image" && item.data && item.mimeType) {
					parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "user", parts });
		} else if (msg.role === "assistant") {
			const blocks = (typeof msg.content === "string"
				? [{ type: "text" as const, text: msg.content }]
				: Array.isArray(msg.content)
					? msg.content
					: []) as PiAssistantBlock[];
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			const parts: WirePart[] = [];

			for (const block of blocks) {
				if (block.type === "text") {
					const carrier = block as PiTextBlock & SignatureCarrier;
					const signature = resolveThoughtSignature(
						isSameProviderAndModel,
						carrier.thoughtSignature ?? carrier.textSignature,
						false,
					);
					if ((!block.text || block.text.trim() === "") && !signature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(signature ? { thoughtSignature: signature } : {}),
					});
				} else if (block.type === "thinking") {
					if (isSameProviderAndModel) {
						const signature = resolveThoughtSignature(
							true,
							block.thinkingSignature,
							isClaudeThinking,
						);
						if ((!block.thinking || block.thinking.trim() === "") && !signature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(signature ? { thoughtSignature: signature } : {}),
						});
					} else {
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({ text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					const signature = resolveThoughtSignature(
						isSameProviderAndModel,
						block.thoughtSignature,
						false,
					);
					parts.push({
						functionCall: {
							name: toWireName(block.name),
							args: block.arguments ?? {},
							...(needIds ? { id: normalizeToolCallId(block.id) } : {}),
						},
						...(signature ? { thoughtSignature: signature } : {}),
					});
				}
			}

			if (parts.length === 0) continue;
			contents.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const content = msg.content as
				| Array<{ type: string; text?: string; data?: string; mimeType?: string }>
				| string;
			const textContent =
				typeof content === "string"
					? content
					: content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n");
			const imageContent =
				typeof content === "string"
					? []
					: content.filter((c) => c.type === "image" && c.data && c.mimeType);

			const responseValue = textContent
				? sanitizeSurrogates(textContent)
				: imageContent.length > 0
					? "(see attached image)"
					: "";
			const imageParts = imageContent.map((img) => ({
				inlineData: { mimeType: img.mimeType!, data: img.data! },
			}));

			const functionResponsePart: WirePart = {
				functionResponse: {
					name: toWireName(msg.toolName ?? ""),
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(imageContent.length > 0 && supportsMultimodalFunctionResponse(model.id)
						? { parts: imageParts }
						: {}),
					...(needIds && msg.toolCallId ? { id: normalizeToolCallId(msg.toolCallId) } : {}),
				},
			};

			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({ role: "user", parts: [functionResponsePart] });
			}

			if (imageContent.length > 0 && !supportsMultimodalFunctionResponse(model.id)) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

// ---------------------------------------------------------------------------
// Tool declaration conversion
// ---------------------------------------------------------------------------

export interface PiToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * Extract active tools by replaying transcript system messages (pi >= 0.86).
 * Handles toolsAdded and toolsRemoved deltas in order.
 */
export function getCurrentTools(
	messages: Array<{ role: string; [key: string]: unknown }>,
): PiToolLike[] {
	const tools = new Map<string, PiToolLike>();
	for (const msg of messages) {
		if (msg.role !== "system") continue;
		const removed = msg.toolsRemoved as Array<{ name: string }> | undefined;
		for (const tool of removed ?? []) {
			tools.delete(tool.name);
		}
		const added = msg.toolsAdded as PiToolLike[] | undefined;
		for (const tool of added ?? []) {
			tools.set(tool.name, tool);
		}
	}
	return [...tools.values()];
}

/**
 * Extract the full system prompt by replaying transcript system messages (pi >= 0.86).
 * Replays base content and named prompt sections in order.
 */
export function getCurrentSystemPrompt(
	messages: Array<{ role: string; [key: string]: unknown }>,
): string {
	const content: string[] = [];
	const sections = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "system") continue;
		const rawContent = msg.content;
		const text =
			typeof rawContent === "string"
				? rawContent
				: Array.isArray(rawContent)
					? (rawContent as Array<{ type?: string; text?: string }>)
							.filter((b) => b && b.type === "text" && typeof b.text === "string")
							.map((b) => b.text!)
							.join("\n")
					: "";
		if (text.length > 0) content.push(text);
		const rawSections = msg.sections as Record<string, string | null> | undefined;
		if (rawSections && typeof rawSections === "object") {
			for (const [name, value] of Object.entries(rawSections)) {
				if (value === null) sections.delete(name);
				else if (typeof value === "string") sections.set(name, value);
			}
		}
	}
	const parts = [...content, ...sections.values()].filter(Boolean);
	return parts.join("\n\n");
}

/**
 * Resolve the tool loadout from either modern transcript system messages (pi >= 0.86)
 * or legacy context.tools (pi <= 0.85).
 */
export function resolveTools(context: {
	tools?: PiToolLike[];
	messages?: Array<{ role: string; [key: string]: unknown }>;
}): PiToolLike[] {
	const messages = context.messages ?? [];
	const hasSystemTools = messages.some(
		(m) =>
			m.role === "system" &&
			(Array.isArray((m as Record<string, unknown>).toolsAdded) ||
				Array.isArray((m as Record<string, unknown>).toolsRemoved)),
	);
	if (hasSystemTools) {
		return getCurrentTools(messages);
	}
	if (Array.isArray(context.tools) && context.tools.length > 0) {
		return context.tools;
	}
	return [];
}

/**
 * Resolve the full system prompt from either modern transcript system messages (pi >= 0.86)
 * or legacy context.systemPrompt (pi <= 0.85).
 */
export function resolveSystemPrompt(context: {
	systemPrompt?: string;
	messages?: Array<{ role: string; [key: string]: unknown }>;
}): string {
	const messages = context.messages ?? [];
	const promptFromMessages = getCurrentSystemPrompt(messages);
	const basePrompt = typeof context.systemPrompt === "string" ? context.systemPrompt.trim() : "";

	if (basePrompt && promptFromMessages) {
		if (promptFromMessages.includes(basePrompt)) return promptFromMessages;
		if (basePrompt.includes(promptFromMessages)) return basePrompt;
		return `${basePrompt}\n\n${promptFromMessages}`;
	}
	return promptFromMessages || basePrompt;
}

export function convertTools(
	tools: PiToolLike[],
	toWireName: (realName: string) => string,
): Array<{ functionDeclarations: unknown[] }> | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: toWireName(tool.name),
				description: tool.description ?? "",
				parameters: toGeminiSchema(tool.parameters),
			})),
		},
	];
}

export function buildSystemInstruction(
	modelId: string,
	basePrompt?: string,
	hasTools?: boolean,
): { parts: Array<{ text: string }> } | undefined {
	const parts: Array<{ text: string }> = [];
	if (basePrompt && basePrompt.trim()) {
		parts.push({ text: basePrompt.trim() });
	}

	const isClaude = isClaudeModel(modelId);
	const isThinking = isClaudeThinkingModel(modelId);

	if (isClaude && hasTools) {
		parts.push({ text: CLAUDE_TOOL_SYSTEM_INSTRUCTION });
	}
	if (isThinking && hasTools) {
		parts.push({ text: CLAUDE_INTERLEAVED_THINKING_HINT });
	}

	if (parts.length === 0) return undefined;
	return { parts };
}

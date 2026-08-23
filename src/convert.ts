/**
 * Convert pi Context (messages + tools) into the Gemini-style `contents` /
 * `tools` format expected by the Antigravity (Cloud Code Assist) API.
 *
 * Adapted from pi-ai's google-shared.ts converter, adjusted for Antigravity:
 * - Tools use the legacy OpenAPI-style `parameters` field (required by Cloud
 *   Code Assist; it translates them to Anthropic input_schema for Claude).
 * - Function names are sanitized to Antigravity's rules and mapped back to
 *   the original pi tool names on the way out.
 * - Missing/invalid thought signatures on Claude thinking models are replaced
 *   with the officially supported "skip_thought_signature_validator" sentinel.
 */
import { SKIP_THOUGHT_SIGNATURE } from "./constants.js";

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/** Thought signatures must be base64 for Google APIs (TYPE_BYTES). */
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

/**
 * Only keep signatures from the same provider/model with valid base64;
 * otherwise fall back to the skip-validation sentinel so Claude thinking
 * models don't reject replayed context outright.
 */
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

/** Models behind Cloud Code Assist that require explicit tool call IDs. */
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

/**
 * Build a bidirectional wire-name map for the given tools. Multiple tools may
 * sanitize to the same wire name; disambiguate with a numeric suffix.
 */
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
// JSON Schema sanitization (OpenAPI 3.03 subset)
// ---------------------------------------------------------------------------

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
	"default",
	"examples",
	"const", // unsupported by the API; drop rather than fail
]);

type JsonSchemaLike = Record<string, unknown>;

function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}
	const result: JsonSchemaLike = {};
	for (const [key, value] of Object.entries(schema as JsonSchemaLike)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] =
			key === "type" && typeof value === "object" && value !== null
				? undefined // e.g. { type: { const: ... } } — drop invalid type objects
				: sanitizeForOpenApi(value);
	}
	if (result.type === undefined && result.properties === undefined && result.required === undefined) {
		result.type = "string";
	}
	return result;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

type WirePart = Record<string, unknown>;
interface WireContent {
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

interface PiMessageLike {
	role: string;
	content: unknown;
	provider?: string;
	model?: string;
	// toolResult fields
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/**
 * Convert pi messages into Gemini contents. `toolNameMap` maps sanitized wire
 * names back to real names; assistant history uses the forward direction.
 */
export function convertMessages(
	model: { id: string; provider: string },
	messages: PiMessageLike[],
	toRealName: (wireName: string) => string,
	toWireName: (realName: string) => string,
): WireContent[] {
	const contents: WireContent[] = [];
	const needIds = requiresToolCallId(model.id);
	const isClaudeThinkingModel = model.id.startsWith("claude-") && model.id.includes("thinking");

	const normalizeToolCallId = (id: string) =>
		needIds ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (!msg.content) continue;
				contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
				continue;
			}
			const parts: WirePart[] = [];
			for (const item of msg.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
				if (item.type === "text" && item.text) {
					parts.push({ text: sanitizeSurrogates(item.text) });
				} else if (item.type === "image" && item.data && item.mimeType) {
					parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "user", parts });
		} else if (msg.role === "assistant") {
			const blocks = (msg.content ?? []) as PiAssistantBlock[];
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			const parts: WirePart[] = [];

			for (const block of blocks) {
				if (block.type === "text") {
					const carrier = block as PiTextBlock & SignatureCarrier;
					const signature = resolveThoughtSignature(isSameProviderAndModel, carrier.thoughtSignature ?? carrier.textSignature, false);
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
							// Claude thinking models validate signatures around tool use;
							// a missing one is replaced with the skip sentinel.
							isClaudeThinkingModel,
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
					const signature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature, false);
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
			const content = msg.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }> | string;
			const textContent = typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const imageContent =
				typeof content === "string"
					? []
					: content.filter((c) => c.type === "image" && c.data && c.mimeType);

			const responseValue = textContent ? sanitizeSurrogates(textContent) : imageContent.length > 0 ? "(see attached image)" : "";
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

			// All function responses must be merged into a single user turn.
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

interface PiToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * Convert tools to Antigravity functionDeclarations using the legacy OpenAPI
 * `parameters` field (Cloud Code Assist translates these for Claude models).
 */
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
				parameters: sanitizeForOpenApi(tool.parameters),
			})),
		},
	];
}

/**
 * Claude-specific Request Transformations.
 * Ported from opencode-antigravity-auth-updated/src/plugin/transform/claude.ts
 */
import type { RequestPayload, ThinkingConfig } from "./types.js";
import {
	EMPTY_SCHEMA_PLACEHOLDER_NAME,
	EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
} from "../constants.js";
import { isClaudeModel, isClaudeThinkingModel } from "../model-resolver.js";

export { isClaudeModel, isClaudeThinkingModel };

export const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;

export const CLAUDE_INTERLEAVED_THINKING_HINT =
	"Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";

export function configureClaudeToolConfig(payload: RequestPayload): void {
	if (!payload.toolConfig) {
		payload.toolConfig = {};
	}
	if (typeof payload.toolConfig === "object" && payload.toolConfig !== null) {
		const toolConfig = payload.toolConfig as Record<string, unknown>;
		if (!toolConfig.functionCallingConfig) {
			toolConfig.functionCallingConfig = {};
		}
		if (
			typeof toolConfig.functionCallingConfig === "object" &&
			toolConfig.functionCallingConfig !== null
		) {
			(toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
		}
	}
}

export function buildClaudeThinkingConfig(
	includeThoughts: boolean,
	thinkingBudget?: number,
): ThinkingConfig {
	return {
		include_thoughts: includeThoughts,
		...(typeof thinkingBudget === "number" && thinkingBudget > 0
			? { thinking_budget: thinkingBudget }
			: {}),
	};
}

export function ensureClaudeMaxOutputTokens(
	generationConfig: Record<string, unknown>,
	thinkingBudget: number,
): void {
	const currentMax = (generationConfig.maxOutputTokens ?? generationConfig.max_output_tokens) as
		| number
		| undefined;
	if (!currentMax || currentMax <= thinkingBudget) {
		generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
		if (generationConfig.max_output_tokens !== undefined) {
			delete generationConfig.max_output_tokens;
		}
	}
}

export function appendClaudeThinkingHint(
	payload: RequestPayload,
	hint: string = CLAUDE_INTERLEAVED_THINKING_HINT,
): void {
	const existing = payload.systemInstruction;
	if (typeof existing === "string") {
		payload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
	} else if (existing && typeof existing === "object") {
		const sys = existing as Record<string, unknown>;
		const partsValue = sys.parts;
		if (Array.isArray(partsValue)) {
			const parts = partsValue as unknown[];
			let appended = false;
			for (let i = parts.length - 1; i >= 0; i--) {
				const part = parts[i];
				if (part && typeof part === "object") {
					const partRecord = part as Record<string, unknown>;
					if (typeof partRecord.text === "string") {
						partRecord.text = `${partRecord.text}\n\n${hint}`;
						appended = true;
						break;
					}
				}
			}
			if (!appended) {
				parts.push({ text: hint });
			}
		} else {
			sys.parts = [{ text: hint }];
		}
		payload.systemInstruction = sys;
	} else if (Array.isArray(payload.contents)) {
		payload.systemInstruction = { parts: [{ text: hint }] };
	}
}

export function normalizeClaudeTools(
	payload: RequestPayload,
	cleanJSONSchema: (schema: unknown) => Record<string, unknown>,
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
	let toolDebugMissing = 0;
	const toolDebugSummaries: string[] = [];

	if (!Array.isArray(payload.tools)) {
		return { toolDebugMissing, toolDebugSummaries };
	}

	const functionDeclarations: unknown[] = [];
	const passthroughTools: unknown[] = [];

	const normalizeSchema = (schema: unknown): Record<string, unknown> => {
		const createPlaceholderSchema = (base: Record<string, unknown> = {}): Record<string, unknown> => ({
			...base,
			type: "object",
			properties: {
				[EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
					type: "boolean",
					description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
				},
			},
			required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
		});

		if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
			toolDebugMissing += 1;
			return createPlaceholderSchema();
		}

		const cleaned = cleanJSONSchema(schema);
		if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
			toolDebugMissing += 1;
			return createPlaceholderSchema();
		}

		const hasProperties =
			cleaned.properties &&
			typeof cleaned.properties === "object" &&
			Object.keys(cleaned.properties as Record<string, unknown>).length > 0;

		cleaned.type = "object";

		if (!hasProperties) {
			cleaned.properties = {
				[EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
					type: "boolean",
					description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
				},
			};
			cleaned.required = Array.isArray(cleaned.required)
				? Array.from(new Set([...(cleaned.required as string[]), EMPTY_SCHEMA_PLACEHOLDER_NAME]))
				: [EMPTY_SCHEMA_PLACEHOLDER_NAME];
		}

		return cleaned;
	};

	(payload.tools as unknown[]).forEach((tool: unknown) => {
		const t = tool as Record<string, unknown>;

		const pushDeclaration = (decl: Record<string, unknown> | undefined, source: string): void => {
			const schema =
				decl?.parameters ||
				decl?.parametersJsonSchema ||
				decl?.input_schema ||
				decl?.inputSchema ||
				t.parameters ||
				t.parametersJsonSchema ||
				t.input_schema ||
				t.inputSchema ||
				(t.function as Record<string, unknown> | undefined)?.parameters ||
				(t.function as Record<string, unknown> | undefined)?.parametersJsonSchema ||
				(t.function as Record<string, unknown> | undefined)?.input_schema ||
				(t.function as Record<string, unknown> | undefined)?.inputSchema ||
				(t.custom as Record<string, unknown> | undefined)?.parameters ||
				(t.custom as Record<string, unknown> | undefined)?.parametersJsonSchema ||
				(t.custom as Record<string, unknown> | undefined)?.input_schema;

			let name =
				decl?.name ||
				t.name ||
				(t.function as Record<string, unknown> | undefined)?.name ||
				(t.custom as Record<string, unknown> | undefined)?.name ||
				`tool-${functionDeclarations.length}`;

			name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

			const description =
				decl?.description ||
				t.description ||
				(t.function as Record<string, unknown> | undefined)?.description ||
				(t.custom as Record<string, unknown> | undefined)?.description ||
				"";

			functionDeclarations.push({
				name,
				description: String(description || ""),
				parameters: normalizeSchema(schema),
			});

			toolDebugSummaries.push(`decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`);
		};

		if (Array.isArray(t.functionDeclarations) && (t.functionDeclarations as unknown[]).length > 0) {
			(t.functionDeclarations as Record<string, unknown>[]).forEach((decl) =>
				pushDeclaration(decl, "functionDeclarations"),
			);
			return;
		}

		if (t.function || t.custom || t.parameters || t.input_schema || t.inputSchema) {
			pushDeclaration(
				(t.function as Record<string, unknown> | undefined) ??
					(t.custom as Record<string, unknown> | undefined) ??
					t,
				"function/custom",
			);
			return;
		}

		passthroughTools.push(tool);
	});

	const finalTools: unknown[] = [];
	if (functionDeclarations.length > 0) {
		finalTools.push({ functionDeclarations });
	}
	payload.tools = finalTools.concat(passthroughTools);

	return { toolDebugMissing, toolDebugSummaries };
}

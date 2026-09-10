/**
 * Gemini-specific Request Transformations.
 * Ported from opencode-antigravity-auth-updated/src/plugin/transform/gemini.ts
 */
import type { RequestPayload, ThinkingConfig, ThinkingTier } from "./types.js";
import {
	EMPTY_SCHEMA_PLACEHOLDER_NAME,
	EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
} from "../constants.js";

const UNSUPPORTED_SCHEMA_FIELDS = new Set([
	"additionalProperties",
	"$schema",
	"$id",
	"$comment",
	"$ref",
	"$defs",
	"definitions",
	"const",
	"contentMediaType",
	"contentEncoding",
	"if",
	"then",
	"else",
	"not",
	"patternProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"dependentRequired",
	"dependentSchemas",
	"propertyNames",
	"minContains",
	"maxContains",
]);

export function toGeminiSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return schema;
	}

	const inputSchema = schema as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	const propertyNames = new Set<string>();
	if (inputSchema.properties && typeof inputSchema.properties === "object") {
		for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) {
			propertyNames.add(propName);
		}
	}

	for (const [key, value] of Object.entries(inputSchema)) {
		if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) {
			continue;
		}

		if (key === "type" && typeof value === "string") {
			result[key] = value.toUpperCase();
		} else if (key === "properties" && typeof value === "object" && value !== null) {
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
				props[propName] = toGeminiSchema(propSchema);
			}
			result[key] = props;
		} else if (key === "items" && typeof value === "object") {
			result[key] = toGeminiSchema(value);
		} else if (
			(key === "anyOf" || key === "oneOf" || key === "allOf") &&
			Array.isArray(value)
		) {
			result[key] = value.map((item) => toGeminiSchema(item));
		} else if (key === "enum" && Array.isArray(value)) {
			result[key] = value;
		} else if (key === "default" || key === "examples") {
			result[key] = value;
		} else if (key === "required" && Array.isArray(value)) {
			if (propertyNames.size > 0) {
				const validRequired = value.filter(
					(prop) => typeof prop === "string" && propertyNames.has(prop),
				);
				if (validRequired.length > 0) {
					result[key] = validRequired;
				}
			} else {
				result[key] = value;
			}
		} else {
			result[key] = value;
		}
	}

	if (result.type === "ARRAY" && !result.items) {
		result.items = { type: "STRING" };
	}

	if (
		result.type === "OBJECT" &&
		result.properties &&
		typeof result.properties === "object" &&
		Object.keys(result.properties as Record<string, unknown>).length === 0
	) {
		result.properties = {
			[EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
				type: "BOOLEAN",
				description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
			},
		};
		result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
	}

	return result;
}

export function buildGemini3ThinkingConfig(
	includeThoughts: boolean,
	thinkingLevel: ThinkingTier,
): ThinkingConfig {
	return {
		includeThoughts,
		thinkingLevel,
	};
}

export function buildGemini25ThinkingConfig(
	includeThoughts: boolean,
	thinkingBudget?: number,
): ThinkingConfig {
	return {
		includeThoughts,
		...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
	};
}

export interface ImageConfig {
	aspectRatio?: string;
}

const VALID_ASPECT_RATIOS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
];

export function buildImageGenerationConfig(): ImageConfig {
	const aspectRatio = process.env.PI_IMAGE_ASPECT_RATIO || process.env.OPENCODE_IMAGE_ASPECT_RATIO || "1:1";
	if (VALID_ASPECT_RATIOS.includes(aspectRatio)) {
		return { aspectRatio };
	}
	return { aspectRatio: "1:1" };
}

export interface WrapToolsResult {
	wrappedFunctionCount: number;
	passthroughToolCount: number;
}

function isWebSearchTool(tool: Record<string, unknown>): boolean {
	if (tool.googleSearch || tool.googleSearchRetrieval) return true;
	if (tool.type === "web_search_20250305") return true;
	const name = tool.name as string | undefined;
	if (name === "web_search" || name === "google_search") return true;
	return false;
}

export function wrapToolsAsFunctionDeclarations(payload: RequestPayload): WrapToolsResult {
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		return { wrappedFunctionCount: 0, passthroughToolCount: 0 };
	}

	const functionDeclarations: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}> = [];

	const passthroughTools: unknown[] = [];
	let hasWebSearchTool = false;

	for (const tool of payload.tools as Array<Record<string, unknown>>) {
		if (tool.googleSearch || tool.googleSearchRetrieval || tool.codeExecution) {
			passthroughTools.push(tool);
			continue;
		}

		if (isWebSearchTool(tool)) {
			hasWebSearchTool = true;
			continue;
		}

		if (tool.functionDeclarations) {
			if (Array.isArray(tool.functionDeclarations)) {
				for (const decl of tool.functionDeclarations as Array<Record<string, unknown>>) {
					functionDeclarations.push({
						name: String(decl.name || `tool-${functionDeclarations.length}`),
						description: String(decl.description || ""),
						parameters: toGeminiSchema(
							(decl.parameters as Record<string, unknown>) || {
								type: "OBJECT",
								properties: {},
							},
						) as Record<string, unknown>,
					});
				}
			}
			continue;
		}

		const fn = tool.function as Record<string, unknown> | undefined;
		const custom = tool.custom as Record<string, unknown> | undefined;

		const name = String(tool.name || fn?.name || custom?.name || `tool-${functionDeclarations.length}`);
		const description = String(tool.description || fn?.description || custom?.description || "");
		const schema = (fn?.input_schema ||
			fn?.parameters ||
			fn?.inputSchema ||
			custom?.input_schema ||
			custom?.parameters ||
			tool.parameters ||
			tool.input_schema ||
			tool.inputSchema || { type: "OBJECT", properties: {} }) as Record<string, unknown>;

		functionDeclarations.push({
			name,
			description,
			parameters: toGeminiSchema(schema) as Record<string, unknown>,
		});
	}

	const finalTools: unknown[] = [];
	if (functionDeclarations.length > 0) {
		finalTools.push({ functionDeclarations });
	}
	finalTools.push(...passthroughTools);

	if (hasWebSearchTool && functionDeclarations.length === 0) {
		finalTools.push({ googleSearch: {} });
	}

	payload.tools = finalTools;

	return {
		wrappedFunctionCount: functionDeclarations.length,
		passthroughToolCount:
			passthroughTools.length + (hasWebSearchTool && functionDeclarations.length === 0 ? 1 : 0),
	};
}

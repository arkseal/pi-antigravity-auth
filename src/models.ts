/**
 * Model catalog for the Antigravity provider and resolution of pi thinking
 * levels to Antigravity/Cloud Code backend model ids and thinking configs.
 *
 * Backend id mappings are ported from
 * opencode-antigravity-auth-updated/src/plugin/transform/model-resolver.ts.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ResolvedBackendModel {
	/** Model id sent to the Antigravity API. */
	model: string;
	/** Gemini 3-style string thinking level (sent via thinkingConfig.thinkingLevel). */
	thinkingLevel?: string;
	/** Numeric thinking budget (sent via thinkingConfig.thinkingBudget, Claude style). */
	thinkingBudget?: number;
}

// --- Model catalog ----------------------------------------------------------

const GEMINI_LIMITS = { context: 1_048_576, output: 65_536 };
const CLAUDE_LIMITS = { context: 200_000, output: 64_000 };
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: CLAUDE_LIMITS.context,
		maxTokens: CLAUDE_LIMITS.output,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		reasoning: false,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: CLAUDE_LIMITS.context,
		maxTokens: CLAUDE_LIMITS.output,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "high",
			high: "high",
			xhigh: null,
			max: "high",
		},
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
		thinkingLevelMap: {
			minimal: "low",
			low: "low",
			medium: "low",
			high: "high",
			xhigh: null,
			max: "high",
		},
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
		thinkingLevelMap: {
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "high",
		},
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
	},
];

// --- Thinking budgets -------------------------------------------------------

const CLAUDE_THINKING_BUDGETS: Record<string, number> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 32768,
	xhigh: 32768,
	max: 32768,
};

const GEMINI_25_FLASH_BUDGETS: Record<string, number> = {
	minimal: 512,
	low: 6144,
	medium: 12288,
	high: 24576,
	xhigh: 24576,
	max: 24576,
};

// --- Helpers ----------------------------------------------------------------

function normalizeLevel(level: string): string {
	switch (level) {
		case "minimal":
			return "minimal";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return "high";
		default:
			return "low";
	}
}

function isClaude(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

/**
 * Resolve a pi model id + thinking level to the backend model id and thinking
 * configuration understood by the Cloud Code Assist API.
 */
export function resolveBackendModel(modelId: string, reasoning?: string): ResolvedBackendModel {
	const lower = modelId.toLowerCase();

	// Claude models: bare id + numeric budget.
	if (isClaude(modelId)) {
		if (!modelId.toLowerCase().includes("thinking")) {
			return { model: modelId };
		}
		const budget = reasoning ? CLAUDE_THINKING_BUDGETS[reasoning] : undefined;
		return { model: modelId, thinkingBudget: typeof budget === "number" ? budget : CLAUDE_THINKING_BUDGETS.high! };
	}

	const level = normalizeLevel(reasoning ?? "low");

	// gemini-3.1-pro: low tier -> "gemini-3.1-pro-low", high/medium -> "gemini-pro-agent"
	// (the backend has no medium tier; the UI map folds medium into high).
	if (/^gemini-3\.1-pro/.test(lower)) {
		if (level === "high" || level === "medium") {
			return { model: "gemini-pro-agent", thinkingLevel: "high" };
		}
		return { model: "gemini-3.1-pro-low", thinkingLevel: "low" };
	}

	// gemini-3.5-flash: non-high -> "gemini-3.5-flash-low", high -> "gemini-3-flash-agent".
	if (/^gemini-3\.5-flash/.test(lower)) {
		if (level === "high") return { model: "gemini-3-flash-agent", thinkingLevel: "high" };
		return { model: "gemini-3.5-flash-low", thinkingLevel: "low" };
	}

	// gemini-3.6-flash: distinct backend ids per tier.
	if (/^gemini-3\.6-flash/.test(lower)) {
		const suffix = level === "minimal" ? "low" : level;
		return { model: `gemini-3.6-flash-${suffix}`, thinkingLevel: suffix };
	}

	// gemini-3.7-flash: single tiered backend id with thinking levels.
	if (/^gemini-3\.7-flash/.test(lower)) {
		return { model: "gemini-3.7-flash-tiered", thinkingLevel: level === "minimal" ? "low" : level };
	}

	// Remaining Gemini 3 models use the bare name plus a thinkingLevel param.
	if (/^gemini-3/.test(lower)) {
		return { model: modelId, thinkingLevel: level };
	}

	// Gemini 2.x uses numeric budgets.
	if (/^gemini-2\.5/.test(lower)) {
		const budget = reasoning ? GEMINI_25_FLASH_BUDGETS[reasoning] : undefined;
		return { model: modelId, thinkingBudget: typeof budget === "number" ? budget : GEMINI_25_FLASH_BUDGETS.low! };
	}

	return { model: modelId };
}

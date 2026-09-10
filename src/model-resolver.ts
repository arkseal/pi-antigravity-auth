/**
 * Model Resolution with Thinking Tier Support.
 * Ported from opencode-antigravity-auth-updated/src/plugin/transform/model-resolver.ts
 */

export type ThinkingTier = "minimal" | "low" | "medium" | "high" | "max";

export interface ResolvedBackendModel {
	/** Model id sent to the Antigravity API. */
	model: string;
	/** Gemini 3-style string thinking level (sent via thinkingConfig.thinkingLevel). */
	thinkingLevel?: string;
	/** Numeric thinking budget (sent via thinkingConfig.thinkingBudget, Claude style). */
	thinkingBudget?: number;
	/** Whether this is an image generation model. */
	isImageModel?: boolean;
}

export const THINKING_TIER_BUDGETS = {
	claude: { minimal: 2048, low: 8192, medium: 16384, high: 32768, max: 32768 },
	"gemini-2.5-pro": { minimal: 2048, low: 8192, medium: 16384, high: 32768, max: 32768 },
	"gemini-2.5-flash": { minimal: 512, low: 6144, medium: 12288, high: 24576, max: 24576 },
	default: { minimal: 1024, low: 4096, medium: 8192, high: 16384, max: 16384 },
} as const;

export const GEMINI_3_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export const MODEL_ALIASES: Record<string, string> = {
	"gemini-3-pro-low": "gemini-3-pro",
	"gemini-3-pro-high": "gemini-3-pro",
	"gemini-3.1-pro-low": "gemini-3.1-pro",
	"gemini-3.1-pro-high": "gemini-3.1-pro",
	"gemini-3-flash-low": "gemini-3-flash",
	"gemini-3-flash-medium": "gemini-3-flash",
	"gemini-3-flash-high": "gemini-3-flash",
	"gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
	"gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
	"gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
	"gemini-claude-opus-4-6-thinking-max": "claude-opus-4-6-thinking",
	"gemini-claude-sonnet-4-6": "claude-sonnet-4-6",
	"gemini-3-pro-image": "gemini-3.1-flash-image",
	"gemini-3.1-flash-image": "gemini-3.1-flash-image",
};

const TIER_REGEX = /-(minimal|low|medium|high|max)$/i;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_31_PRO_REGEX = /^gemini-3\.1-pro(?:-(low|high))?$/i;
const GEMINI_31_PRO_LOW_MODEL = "gemini-3.1-pro-low";
const GEMINI_31_PRO_HIGH_MODEL = "gemini-pro-agent";
const GEMINI_35_FLASH_REGEX = /^gemini-3\.5-flash(?:-(minimal|low|medium|high))?$/i;
const GEMINI_36_FLASH_REGEX = /^gemini-3\.6-flash(?:-(minimal|low|medium|high))?$/i;
const GEMINI_36_FLASH_LOW_MODEL = "gemini-3.6-flash-low";
const GEMINI_36_FLASH_MEDIUM_MODEL = "gemini-3.6-flash-medium";
const GEMINI_36_FLASH_HIGH_MODEL = "gemini-3.6-flash-high";
const GEMINI_37_FLASH_REGEX = /^gemini-3\.7-flash(?:-(minimal|low|medium|high))?$/i;
const GEMINI_37_FLASH_TIERED_MODEL = "gemini-3.7-flash-tiered";
export const GEMINI_38_FLASH_REGEX = /^gemini-3\.8-flash(?:-(minimal|low|medium|high))?$/i;
const GEMINI_38_FLASH_TIERED_MODEL = "gemini-3.8-flash-tiered";

export function isClaudeModel(model: string): boolean {
	return model.toLowerCase().includes("claude");
}

export function isClaudeThinkingModel(model: string): boolean {
	const lower = model.toLowerCase();
	return lower.includes("claude") && lower.includes("thinking");
}

export function isImageGenerationModel(model: string): boolean {
	const lower = model.toLowerCase();
	return lower.includes("image") || lower.includes("imagen");
}

export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
	const lower = model.toLowerCase();
	if (lower.includes("claude")) {
		return "claude";
	}
	if (lower.includes("flash")) {
		return "gemini-flash";
	}
	return "gemini-pro";
}

function normalizeThinkingLevel(level: string): string {
	switch (level.toLowerCase()) {
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

/**
 * Resolve model name and thinking tier to the Antigravity backend model ID and thinking configuration.
 */
export function resolveBackendModel(modelId: string, reasoning?: string): ResolvedBackendModel {
	const lower = modelId.toLowerCase().replace(QUOTA_PREFIX_REGEX, "");

	// Image models
	if (isImageGenerationModel(lower)) {
		return { model: "gemini-3.1-flash-image", isImageModel: true };
	}

	// Claude models
	if (isClaudeModel(lower)) {
		const isThinking = isClaudeThinkingModel(lower);
		if (!isThinking) {
			return { model: lower };
		}
		const tier = (reasoning?.toLowerCase() ?? "high") as keyof typeof THINKING_TIER_BUDGETS.claude;
		const budget = THINKING_TIER_BUDGETS.claude[tier] ?? THINKING_TIER_BUDGETS.claude.high;
		return { model: lower, thinkingBudget: budget };
	}

	// Gemini 3.8 Flash
	if (GEMINI_38_FLASH_REGEX.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		return {
			model: GEMINI_38_FLASH_TIERED_MODEL,
			thinkingLevel: level === "minimal" ? "low" : level,
		};
	}

	// Gemini 3.7 Flash
	if (GEMINI_37_FLASH_REGEX.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		return {
			model: GEMINI_37_FLASH_TIERED_MODEL,
			thinkingLevel: level === "minimal" ? "low" : level,
		};
	}

	// Gemini 3.6 Flash
	if (GEMINI_36_FLASH_REGEX.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		if (level === "high") return { model: GEMINI_36_FLASH_HIGH_MODEL, thinkingLevel: "high" };
		if (level === "medium") return { model: GEMINI_36_FLASH_MEDIUM_MODEL, thinkingLevel: "medium" };
		return { model: GEMINI_36_FLASH_LOW_MODEL, thinkingLevel: "low" };
	}

	// Gemini 3.5 Flash
	if (GEMINI_35_FLASH_REGEX.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		if (level === "high") return { model: "gemini-3-flash-agent", thinkingLevel: "high" };
		return { model: "gemini-3.5-flash-low", thinkingLevel: "low" };
	}

	// Gemini 3.1 Pro
	if (GEMINI_31_PRO_REGEX.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		if (level === "high" || level === "medium") {
			return { model: GEMINI_31_PRO_HIGH_MODEL, thinkingLevel: "high" };
		}
		return { model: GEMINI_31_PRO_LOW_MODEL, thinkingLevel: "low" };
	}

	// Gemini 3 Flash
	if (/^gemini-3-flash/i.test(lower)) {
		const level = normalizeThinkingLevel(reasoning ?? "low");
		return { model: "gemini-3-flash", thinkingLevel: level };
	}

	// Gemini 2.5 Flash
	if (/^gemini-2\.5/i.test(lower)) {
		const tier = (reasoning?.toLowerCase() ?? "low") as keyof typeof THINKING_TIER_BUDGETS["gemini-2.5-flash"];
		const budget = THINKING_TIER_BUDGETS["gemini-2.5-flash"][tier] ?? THINKING_TIER_BUDGETS["gemini-2.5-flash"].low;
		return { model: lower, thinkingBudget: budget };
	}

	return { model: lower };
}

/**
 * Model catalog for the Antigravity provider.
 * Ported from opencode-antigravity-auth-updated/src/plugin/config/models.ts.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type { ThinkingTier, ResolvedBackendModel } from "./model-resolver.js";
export { resolveBackendModel, getModelFamily, isClaudeModel, isClaudeThinkingModel, isImageGenerationModel } from "./model-resolver.js";

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
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
		thinkingLevelMap: {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "high",
		},
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
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
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
		thinkingLevelMap: {
			minimal: "minimal",
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
	{
		id: "gemini-3.1-flash-image",
		name: "Gemini 3.1 Flash Image (Antigravity)",
		reasoning: false,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
	},
];

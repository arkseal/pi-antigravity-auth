/**
 * Model catalog for the Antigravity provider.
 * Ported from opencode-antigravity-auth-updated/src/plugin/config/models.ts.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type { ThinkingTier, ResolvedBackendModel } from "./model-resolver.js";
export { resolveBackendModel, getModelFamily, isClaudeModel, isClaudeThinkingModel, isArgonModel, isHydrogenModel, isImageGenerationModel } from "./model-resolver.js";

const GEMINI_LIMITS = { context: 1_048_576, output: 65_536 };
const GEMINI_HYDROGEN_LIMITS = { context: 1_048_576, output: 262_144 };
const CLAUDE_LIMITS = { context: 1_000_000, output: 128_000 };
const GPT_OSS_LIMITS = { context: 131_072, output: 32_768 };
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "claude-opus-5-5-thinking",
		name: "Claude Opus 5.5 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: CLAUDE_LIMITS.context,
		maxTokens: CLAUDE_LIMITS.output,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
		},
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5 (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: CLAUDE_LIMITS.context,
		maxTokens: CLAUDE_LIMITS.output,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
		},
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
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
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
		},
	},
	{
		id: "gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite (Antigravity)",
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
		},
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_LIMITS.context,
		maxTokens: GEMINI_LIMITS.output,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	},
	{
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GEMINI_HYDROGEN_LIMITS.context,
		maxTokens: GEMINI_HYDROGEN_LIMITS.output,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "extra",
			max: null,
		},
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (Antigravity)",
		reasoning: false,
		input: ["text", "image"],
		cost: FREE_COST,
		contextWindow: GPT_OSS_LIMITS.context,
		maxTokens: GPT_OSS_LIMITS.output,
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

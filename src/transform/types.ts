import type { ThinkingTier } from "../model-resolver.js";

export type { ThinkingTier };

export interface ThinkingConfig {
	includeThoughts?: boolean;
	include_thoughts?: boolean;
	thinkingLevel?: string;
	thinking_level?: string;
	thinkingBudget?: number;
	thinking_budget?: number;
}

export interface GoogleSearchConfig {
	mode?: "auto" | "off";
}

export interface RequestPayload {
	contents?: unknown[];
	tools?: unknown[];
	toolConfig?: Record<string, unknown>;
	generationConfig?: Record<string, unknown>;
	systemInstruction?: unknown;
	[key: string]: unknown;
}

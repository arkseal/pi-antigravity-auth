/**
 * Cross-Model Metadata Sanitization.
 * Ported from opencode-antigravity-auth-updated/src/plugin/transform/cross-model-sanitizer.ts
 */
import { isClaudeModel, getModelFamily } from "../model-resolver.js";

export type ModelFamily = "claude" | "gemini" | "unknown";

const GEMINI_SIGNATURE_FIELDS = ["thoughtSignature", "thinkingMetadata"] as const;
const CLAUDE_SIGNATURE_FIELDS = ["signature"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripGeminiThinkingMetadata(
	part: Record<string, unknown>,
	preserveNonSignature = true,
): { part: Record<string, unknown>; stripped: number } {
	let stripped = 0;

	if ("thoughtSignature" in part) {
		delete part.thoughtSignature;
		stripped++;
	}

	if ("thinkingMetadata" in part) {
		delete part.thinkingMetadata;
		stripped++;
	}

	if (isPlainObject(part.metadata)) {
		const metadata = part.metadata as Record<string, unknown>;
		if (isPlainObject(metadata.google)) {
			const google = metadata.google as Record<string, unknown>;
			for (const field of GEMINI_SIGNATURE_FIELDS) {
				if (field in google) {
					delete google[field];
					stripped++;
				}
			}
			if (!preserveNonSignature || Object.keys(google).length === 0) {
				delete metadata.google;
			}
			if (Object.keys(metadata).length === 0) {
				delete part.metadata;
			}
		}
	}

	return { part, stripped };
}

export function stripClaudeThinkingFields(
	part: Record<string, unknown>,
): { part: Record<string, unknown>; stripped: number } {
	let stripped = 0;

	if (part.type === "thinking" || part.type === "redacted_thinking") {
		for (const field of CLAUDE_SIGNATURE_FIELDS) {
			if (field in part) {
				delete part[field];
				stripped++;
			}
		}
	}

	if ("signature" in part && typeof part.signature === "string") {
		if (part.signature.length >= 50) {
			delete part.signature;
			stripped++;
		}
	}

	return { part, stripped };
}

export function sanitizeCrossModelPayloadInPlace(
	payload: Record<string, unknown>,
	targetModel: string,
): number {
	const isClaude = isClaudeModel(targetModel);
	const targetFamily: ModelFamily = isClaude ? "claude" : "gemini";
	let totalStripped = 0;

	const sanitizePartsInPlace = (parts: unknown[]): void => {
		for (const part of parts) {
			if (!isPlainObject(part)) continue;
			if (targetFamily === "claude") {
				const result = stripGeminiThinkingMetadata(part as Record<string, unknown>, true);
				totalStripped += result.stripped;
			} else if (targetFamily === "gemini") {
				const result = stripClaudeThinkingFields(part as Record<string, unknown>);
				totalStripped += result.stripped;
			}
		}
	};

	if (Array.isArray(payload.contents)) {
		for (const content of payload.contents) {
			if (isPlainObject(content) && Array.isArray(content.parts)) {
				sanitizePartsInPlace(content.parts);
			}
		}
	}

	return totalStripped;
}

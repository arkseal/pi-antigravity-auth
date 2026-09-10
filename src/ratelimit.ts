/**
 * Rate-limit utilities and re-exports.
 */
import { parseDurationToMs } from "./logging-utils.js";

export {
	parseDurationToMs,
	formatWaitTime,
	formatDuration,
	shortEmail,
	progressBar,
} from "./logging-utils.js";

export { parseRateLimitReason, calculateBackoffMs, type RateLimitReason } from "./accounts.js";

export interface RateLimitInfo {
	retryDelayMs: number | null;
	message?: string;
}

export function extractRateLimitInfo(body: unknown): RateLimitInfo {
	if (!body || typeof body !== "object") return { retryDelayMs: null };
	const error = (body as { error?: unknown }).error;
	if (!error || typeof error !== "object") return { retryDelayMs: null };

	const rawMessage = (error as { message?: unknown }).message;
	const message = typeof rawMessage === "string" ? rawMessage : undefined;

	const details = (error as { details?: unknown[] }).details;
	if (Array.isArray(details)) {
		for (const detail of details) {
			if (!detail || typeof detail !== "object") continue;
			const type = (detail as { "@type"?: string })["@type"];
			if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
				const retryDelay = (detail as { retryDelay?: string }).retryDelay;
				if (typeof retryDelay === "string") {
					const ms = parseDurationToMs(retryDelay);
					if (ms !== null) return { retryDelayMs: ms, message };
				}
			}
		}
	}

	if (message) {
		const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
		if (afterMatch?.[1]) {
			const parsed = parseDurationToMs(afterMatch[1]);
			if (parsed !== null) return { retryDelayMs: parsed, message };
		}
	}
	return { retryDelayMs: null, message };
}

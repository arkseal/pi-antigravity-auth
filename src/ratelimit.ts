/**
 * Rate-limit response parsing for the Antigravity API.
 * Ported from opencode-antigravity-auth-updated/src/plugin.ts.
 */

/** Parse Go-style duration strings ("1h16m0.667s", "3.95s", "200ms") to ms. */
export function parseDurationToMs(duration: string): number | null {
	const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi;
	let totalMs = 0;
	let matchFound = false;
	let match = compoundRegex.exec(duration);
	while (match !== null) {
		matchFound = true;
		const value = Number.parseFloat(match[1]!);
		switch (match[2]!.toLowerCase()) {
			case "h":
				totalMs += value * 3600_000;
				break;
			case "m":
				totalMs += value * 60_000;
				break;
			case "s":
				totalMs += value * 1000;
				break;
			case "ms":
				totalMs += value;
				break;
		}
		match = compoundRegex.exec(duration);
	}
	return matchFound ? totalMs : null;
}

export interface RateLimitInfo {
	retryDelayMs: number | null;
	message?: string;
}

/**
 * Extract retry delay information from an Antigravity error body
 * ({ error: { message, details: [...] } }).
 */
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

/** Human-readable wait duration ("45s", "3m 20s", "2h 5m"). */
export function formatWaitTime(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

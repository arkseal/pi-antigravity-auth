/**
 * Logging and Formatting Utilities.
 */

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

export function formatDuration(ms: number): string {
	const absMs = Math.abs(ms);
	const seconds = Math.floor(absMs / 1000);
	const d = Math.floor(seconds / (24 * 3600));
	const h = Math.floor((seconds % (24 * 3600)) / 3600);
	const m = Math.floor((seconds % 3600) / 60);

	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function shortEmail(email: string): string {
	return email.split("@")[0] || email;
}

export function progressBar(percent: number): string {
	const width = 10;
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	const bar = "█".repeat(filled) + "░".repeat(empty);
	return `[${bar}] ${clamped.toFixed(0)}%`;
}

export function isTruthyFlag(val: string | undefined): boolean {
	if (!val) return false;
	const lower = val.toLowerCase().trim();
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

export function redactToken(token: string | undefined): string {
	if (!token) return "";
	if (token.length <= 8) return "***";
	return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

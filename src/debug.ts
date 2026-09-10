/**
 * Debug logging utilities for Antigravity integration.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { isTruthyFlag } from "./logging-utils.js";

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function isDebugEnabled(): boolean {
	return (
		isTruthyFlag(process.env.PI_ANTIGRAVITY_DEBUG) ||
		isTruthyFlag(process.env.OPENCODE_ANTIGRAVITY_DEBUG)
	);
}

export function getDebugLevel(): number {
	const raw = process.env.PI_ANTIGRAVITY_DEBUG || process.env.OPENCODE_ANTIGRAVITY_DEBUG;
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isNaN(parsed)) return parsed;
	return isTruthyFlag(raw) ? 1 : 0;
}

export function getLogDirectory(): string {
	return join(getAgentDir(), "antigravity-logs");
}

export function debugLogToFile(category: string, data: unknown): void {
	if (!isDebugEnabled()) return;
	try {
		const dir = getLogDirectory();
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const dateStr = new Date().toISOString().slice(0, 10);
		const filePath = join(dir, `antigravity-debug-${dateStr}.log`);
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] [${category}] ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
		appendFileSync(filePath, line, { encoding: "utf8" });
	} catch {
		// Non-fatal if debug file cannot be written
	}
}

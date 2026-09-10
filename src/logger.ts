/**
 * Structured Logger for Antigravity integration.
 */
import { debugLogToFile } from "./debug.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, extra?: Record<string, unknown>): void;
	info(message: string, extra?: Record<string, unknown>): void;
	warn(message: string, extra?: Record<string, unknown>): void;
	error(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
	const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
		debugLogToFile(`${module}:${level}`, { message, ...(extra ?? {}) });
	};

	return {
		debug: (message, extra) => log("debug", message, extra),
		info: (message, extra) => log("info", message, extra),
		warn: (message, extra) => log("warn", message, extra),
		error: (message, extra) => log("error", message, extra),
	};
}

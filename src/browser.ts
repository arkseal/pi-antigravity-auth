/**
 * Cross-platform browser opener (simplified port of plugin.ts openBrowser).
 */
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";

function isWSL(): boolean {
	if (process.platform !== "linux") return false;
	try {
		const release = readFileSync("/proc/version", "utf8").toLowerCase();
		return release.includes("microsoft") || release.includes("wsl");
	} catch {
		return false;
	}
}

/**
 * Attempt to open a URL in the default browser. Returns true when a command
 * was dispatched successfully.
 */
export function openBrowser(url: string): boolean {
	try {
		if (process.platform === "darwin") {
			exec(`open "${url}"`);
			return true;
		}
		if (process.platform === "win32") {
			exec(`start "" "${url}"`);
			return true;
		}
		if (isWSL()) {
			exec(`wslview "${url}"`);
			return true;
		}
		if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			return false; // headless Linux
		}
		exec(`xdg-open "${url}"`);
		return true;
	} catch {
		return false;
	}
}

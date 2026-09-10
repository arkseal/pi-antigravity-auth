/**
 * Quota inspection & Account Management for Google Antigravity.
 * Ported from opencode-antigravity-auth-updated.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	ANTIGRAVITY_ENDPOINT_FALLBACKS,
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_PROVIDER_ID,
} from "./constants.js";
import {
	getAccountManager,
	type ManagedAccount,
	describeAccount,
} from "./accounts.js";
import { executeSearch } from "./search.js";
import { formatDuration, shortEmail, progressBar } from "./logging-utils.js";
export { formatDuration, shortEmail, progressBar };
import { authorizeAntigravity, exchangeAntigravity, startOAuthListener } from "./auth.js";
import { openBrowser } from "./browser.js";

export const CLOUDCODE_METADATA = {
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
};

export interface QuotaBucket {
	bucketId: string;
	displayName: string;
	window?: string;
	resetTime?: string;
	description?: string;
	remainingFraction: number;
}

export interface QuotaGroup {
	buckets: QuotaBucket[];
	displayName: string;
	description?: string;
}

export interface UserQuotaSummaryResponse {
	groups?: QuotaGroup[];
	description?: string;
}

export interface LoadCodeAssistResponse {
	currentTier?: { id?: string };
	paidTier?: { id?: string };
	cloudaicompanionProject?: unknown;
}

export interface AccountQuotaResult {
	email: string;
	success: boolean;
	error?: string;
	groups?: QuotaGroup[];
}

export function extractProjectId(project: unknown): string | undefined {
	if (typeof project === "string" && project) return project;
	if (project && typeof project === "object" && project !== null && "id" in project) {
		const id = (project as { id?: unknown }).id;
		if (typeof id === "string" && id) return id;
	}
	return undefined;
}

export async function loadCodeAssist(accessToken: string): Promise<LoadCodeAssistResponse> {
	const endpoints = ANTIGRAVITY_ENDPOINT_FALLBACKS;

	let lastError: Error | undefined;
	for (const endpoint of endpoints) {
		try {
			const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity",
				},
				body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
			});
			if (response.ok) {
				return (await response.json()) as LoadCodeAssistResponse;
			}
			lastError = new Error(`loadCodeAssist failed (${response.status}) from ${endpoint}`);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw lastError || new Error("loadCodeAssist failed across all endpoints");
}

export async function fetchUserQuotaSummary(
	accessToken: string,
	projectId?: string,
): Promise<UserQuotaSummaryResponse> {
	const payload = projectId ? { project: projectId } : {};
	const endpoints = ANTIGRAVITY_ENDPOINT_FALLBACKS;

	let lastStatus = 0;
	let validData: UserQuotaSummaryResponse | undefined;

	for (const endpoint of endpoints) {
		try {
			const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity",
				},
				body: JSON.stringify(payload),
			});

			if (response.ok) {
				const data = (await response.json()) as UserQuotaSummaryResponse;
				if (data.groups && data.groups.length > 0) {
					return data;
				}
				if (!validData) {
					validData = data;
				}
			} else {
				lastStatus = response.status;
			}
		} catch {
			// Try next endpoint
		}
	}

	if (validData) {
		return validData;
	}

	throw new Error(`retrieveUserQuotaSummary failed (${lastStatus || 500})`);
}

export async function fetchAccountQuota(
	account: ManagedAccount,
	accessToken: string,
): Promise<AccountQuotaResult> {
	const accountLabel = account.email || `account #${account.index + 1}`;
	try {
		let projectId = account.projectId ?? account.managedProjectId;
		if (!projectId) {
			try {
				const codeAssist = await loadCodeAssist(accessToken);
				projectId = extractProjectId(codeAssist.cloudaicompanionProject);
			} catch {
				// Continue without explicit project id
			}
		}

		const quotaResponse = await fetchUserQuotaSummary(accessToken, projectId);
		return {
			email: accountLabel,
			success: true,
			groups: quotaResponse.groups || [],
		};
	} catch (error) {
		return {
			email: accountLabel,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function getLocalRateLimitInfo(accounts: ManagedAccount[]): string {
	const now = Date.now();
	let output = "";

	const rows = accounts.map((acc, index) => {
		const label = acc.email || `account #${index + 1} (${acc.source})`;
		const resets = Object.values(acc.rateLimitResetTimes ?? {}).filter(
			(v): v is number => typeof v === "number",
		);
		const until = resets.length > 0 ? Math.max(...resets) : 0;
		const remaining = until - now;
		const isEnabled = acc.enabled !== false;
		const isVerify = acc.verificationRequired === true;
		const available = isEnabled && !isVerify && (until === 0 || remaining <= 0);

		let statusText = available ? "READY" : "WAIT";
		if (!isEnabled) statusText = "DISABLED";
		if (isVerify) statusText = "VERIFY";

		let resetTimeStr: string;
		if (isVerify) {
			resetTimeStr = "Verification required (403)";
		} else if (!isEnabled) {
			resetTimeStr = "Disabled by user";
		} else if (until === 0) {
			resetTimeStr = "Ready (No active cooldown)";
		} else if (available) {
			resetTimeStr = `Ready (${formatDuration(Math.abs(remaining))} ago)`;
		} else {
			resetTimeStr = `Cooldown: ${formatDuration(remaining)}`;
		}

		return { label, statusText, resetTimeStr };
	});

	output += "```text\n";
	output += "ACCOUNT                        STATUS     COOLDOWN / RESET\n";
	for (const row of rows) {
		const accCol = row.label.slice(0, 30).padEnd(31, " ");
		const statusCol = row.statusText.padEnd(11, " ");
		const resetCol = row.resetTimeStr;
		output += `${accCol}${statusCol}${resetCol}\n`;
	}
	output += "```\n";
	return output;
}

export function formatQuotaReport(results: AccountQuotaResult[], accounts: ManagedAccount[]): string {
	let output = "# ☁️ Antigravity Quota Status\n\n";

	const errors = results.filter((r) => !r.success);
	if (errors.length > 0) {
		output += `⚠️ Errors: ${errors.map((e) => `${shortEmail(e.email)}: ${e.error || "error"}`).join(", ")}\n\n`;
	}

	const now = Date.now();
	const expectedGroups = [
		{
			displayName: "Gemini Models",
			bucketIds: ["gemini-weekly", "gemini-5h"],
			bucketNames: ["Weekly Limit", "Five Hour Limit"],
		},
		{
			displayName: "Claude and GPT models",
			bucketIds: ["3p-weekly", "3p-5h"],
			bucketNames: ["Weekly Limit", "Five Hour Limit"],
		},
	];

	for (const group of expectedGroups) {
		output += `### ${group.displayName}\n`;
		output += "```text\n";
		output += "ACCOUNT             LIMIT               QUOTA               RESET IN\n";

		for (let b = 0; b < group.bucketIds.length; b++) {
			const bucketId = group.bucketIds[b]!;
			const bucketName = group.bucketNames[b]!;

			const accountRows = results.map((result) => {
				let percentage = 100;
				let resetStr = "Ready";

				if (result.success && result.groups) {
					const matchedGroup = result.groups.find((g) =>
						g.displayName.toLowerCase().includes(group.displayName.toLowerCase().split(" ")[0]!),
					);
					if (matchedGroup) {
						const matchedBucket = matchedGroup.buckets.find(
							(bk) =>
								bk.bucketId === bucketId ||
								bk.displayName.toLowerCase() === bucketName.toLowerCase() ||
								(bucketId.includes("weekly") &&
									(bk.window === "weekly" ||
										bk.bucketId.includes("weekly") ||
										bk.displayName.toLowerCase().includes("weekly"))) ||
								(bucketId.includes("5h") &&
									(bk.window === "5h" ||
										bk.bucketId.includes("5h") ||
										bk.displayName.toLowerCase().includes("5-hour") ||
										bk.displayName.toLowerCase().includes("five hour"))),
						);
						if (matchedBucket) {
							percentage = Math.round(matchedBucket.remainingFraction * 100);
							if (percentage < 100 && matchedBucket.resetTime) {
								const remainingMs = new Date(matchedBucket.resetTime).getTime() - now;
								resetStr = remainingMs > 0 ? formatDuration(remainingMs) : "Ready";
							} else {
								resetStr = "Ready";
							}
						}
					}
				} else if (!result.success) {
					resetStr = "Error";
					percentage = 0;
				}

				return {
					email: shortEmail(result.email),
					percentage,
					resetStr,
				};
			});

			accountRows.sort((a, b) => b.percentage - a.percentage);

			for (const row of accountRows) {
				const accCol = row.email.slice(0, 19).padEnd(20, " ");
				const limitCol = bucketName.padEnd(20, " ");
				const barCol = progressBar(row.percentage).padEnd(20, " ");
				const resetCol = row.resetStr.padEnd(12, " ");
				output += `${accCol}${limitCol}${barCol}${resetCol}\n`;
			}
		}

		output += "```\n\n";
	}

	output += "---\n## ⏱️ Local Rate Limit Cache\n\n";
	output += getLocalRateLimitInfo(accounts);

	return output;
}

function findBucket(
	groups: QuotaGroup[] | undefined,
	groupKeyword: string,
	windowKeyword: "5h" | "weekly",
	now: number,
): { pct: number; resetStr: string } {
	if (!groups) return { pct: 100, resetStr: "Ready" };
	const group = groups.find((g) =>
		g.displayName.toLowerCase().includes(groupKeyword.toLowerCase()),
	);
	if (!group) return { pct: 100, resetStr: "Ready" };

	const bucket = group.buckets.find((b) => {
		const id = (b.bucketId || "").toLowerCase();
		const name = (b.displayName || "").toLowerCase();
		const win = (b.window || "").toLowerCase();
		if (windowKeyword === "5h") {
			return (
				id.includes("5h") ||
				id.includes("five") ||
				win.includes("5h") ||
				name.includes("5") ||
				name.includes("five")
			);
		}
		return (
			id.includes("weekly") || win.includes("weekly") || name.includes("weekly") || name.includes("week")
		);
	});

	if (!bucket) return { pct: 100, resetStr: "Ready" };
	const pct = Math.round(bucket.remainingFraction * 100);
	let resetStr = "Ready";
	if (pct < 100 && bucket.resetTime) {
		const rem = new Date(bucket.resetTime).getTime() - now;
		resetStr = rem > 0 ? formatDuration(rem) : "Ready";
	}
	return { pct, resetStr };
}

function formatModelSection(modelName: string, bucket: { pct: number; resetStr: string }): string {
	const name = (modelName + ":").padEnd(8, " ");
	const bar = progressBar(bucket.pct).padEnd(18, " ");
	const reset = `(${bucket.resetStr})`;
	return `${name} ${bar} ${reset}`;
}

export function formatSingleLineQuota(
	results: AccountQuotaResult[],
	accounts?: ManagedAccount[],
): string {
	const now = Date.now();
	if (results.length === 0) {
		if (accounts && accounts.length > 0) {
			return "Usage:  Fetching quota...";
		}
		return "Usage:  No accounts configured (run /login antigravity)";
	}

	const hasMultiple = results.length > 1;
	const accountParts: string[] = [];

	for (const res of results) {
		const email = shortEmail(res.email);
		if (!res.success) {
			const prefix = hasMultiple ? `[${email}] ` : "";
			accountParts.push(`${prefix}⚠️ Error: ${res.error || "failed"}`);
			continue;
		}

		const g5h = findBucket(res.groups, "gemini", "5h", now);
		const c5h = findBucket(res.groups, "claude", "5h", now);
		const gWk = findBucket(res.groups, "gemini", "weekly", now);
		const cWk = findBucket(res.groups, "claude", "weekly", now);

		const g5hTimer = g5h.pct < 100 && g5h.resetStr !== "Ready" ? ` (${g5h.resetStr})` : "";
		const gWkTimer = gWk.pct < 100 && gWk.resetStr !== "Ready" ? ` (${gWk.resetStr})` : "";
		const c5hTimer = c5h.pct < 100 && c5h.resetStr !== "Ready" ? ` (${c5h.resetStr})` : "";
		const cWkTimer = cWk.pct < 100 && cWk.resetStr !== "Ready" ? ` (${cWk.resetStr})` : "";

		const geminiStr = `Gemini:  5h ${progressBar(g5h.pct)}${g5hTimer} · Wk ${progressBar(gWk.pct)}${gWkTimer}`;
		const claudeStr = `Claude:  5h ${progressBar(c5h.pct)}${c5hTimer} · Wk ${progressBar(cWk.pct)}${cWkTimer}`;

		const prefix = hasMultiple ? `[${email}] ` : "";
		accountParts.push(`${prefix}${geminiStr}   │   ${claudeStr}`);
	}

	return `Usage:  ${accountParts.join("   ┃   ")}`;
}

export function formatTwoLineQuota(
	results: AccountQuotaResult[],
	accounts?: ManagedAccount[],
): string[] {
	const now = Date.now();

	if (results.length === 0) {
		if (accounts && accounts.length > 0) {
			return [
				"Usage:  5-Hour   │   Fetching quota...",
				"Usage:  Weekly   │   Fetching quota...",
			];
		}
		return [
			"Usage:  5-Hour   │   No accounts configured",
			"Usage:  Weekly   │   Run /login antigravity to authenticate",
		];
	}

	const hasMultiple = results.length > 1;
	const line5hParts: string[] = [];
	const lineWkParts: string[] = [];

	for (const res of results) {
		const email = shortEmail(res.email);
		if (!res.success) {
			const prefix = hasMultiple ? `[${email}] ` : "";
			line5hParts.push(`${prefix}⚠️ Error: ${res.error || "failed"}`);
			lineWkParts.push(`${prefix}⚠️ Error`);
			continue;
		}

		const g5h = findBucket(res.groups, "gemini", "5h", now);
		const c5h = findBucket(res.groups, "claude", "5h", now);
		const gWk = findBucket(res.groups, "gemini", "weekly", now);
		const cWk = findBucket(res.groups, "claude", "weekly", now);

		const prefix = hasMultiple ? `[${email}] ` : "";
		line5hParts.push(
			`${prefix}${formatModelSection("Gemini", g5h)}   │   ${formatModelSection("Claude", c5h)}`,
		);
		lineWkParts.push(
			`${prefix}${formatModelSection("Gemini", gWk)}   │   ${formatModelSection("Claude", cWk)}`,
		);
	}

	return [
		`Usage:  5-Hour   │   ${line5hParts.join("   ┃   ")}`,
		`Usage:  Weekly   │   ${lineWkParts.join("   ┃   ")}`,
	];
}

export function formatCompactQuotaWidget(
	results: AccountQuotaResult[],
	accounts: ManagedAccount[],
	width?: number,
): string[] {
	const singleLine = formatSingleLineQuota(results, accounts);
	const targetWidth = width ?? (process.stdout?.columns || 120);

	if (singleLine.length <= targetWidth) {
		return [singleLine];
	}
	return formatTwoLineQuota(results, accounts);
}

export function formatQuotaStatusText(results: AccountQuotaResult[]): string {
	if (results.length === 0) return "Usage: -";
	const active = results.filter((r) => r.success);
	if (active.length === 0) return "Usage: ⚠️ error";

	const parts: string[] = [];
	for (const res of active) {
		let minGemini = 100;
		let minClaude = 100;
		for (const g of res.groups || []) {
			const isGemini = g.displayName.toLowerCase().includes("gemini");
			const isClaude = g.displayName.toLowerCase().includes("claude");
			for (const b of g.buckets) {
				const pct = Math.round(b.remainingFraction * 100);
				if (isGemini && pct < minGemini) minGemini = pct;
				if (isClaude && pct < minClaude) minClaude = pct;
			}
		}
		parts.push(`Gem: ${minGemini}% · Cld: ${minClaude}%`);
	}
	return `Usage: ${parts.join(" | ")}`;
}

const ANSI_RESET = "\x1b[22;23;24;39m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_DIM = "\x1b[2m";

const PANEL_COLORS = {
	accent: "\x1b[38;2;254;188;56m", // amber/yellow
	success: "\x1b[38;2;95;175;95m", // green
	warning: "\x1b[38;2;255;149;0m", // orange
	error: "\x1b[38;2;235;77;75m", // red
	muted: "\x1b[38;2;108;108;108m", // grey
	text: "\x1b[38;2;0;175;175m", // cyan
};

function panelBold(text: string): string {
	return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

function panelDim(text: string): string {
	return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

function panelColor(color: string, text: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

function renderQuotaBarLine(label: string, pct: number, resetStr: string, width: number): string {
	const prefix = `   ${label.padEnd(3)} `; // 7 chars: "   5h  "
	const clamped = Math.min(100, Math.max(0, pct));
	const pctStr = `${clamped}%`.padStart(4); // 4 chars: " 85%"

	const severityColor = clamped > 50
		? PANEL_COLORS.success
		: clamped >= 20
			? PANEL_COLORS.accent
			: PANEL_COLORS.error;

	let suffix = "";
	if (resetStr && resetStr !== "Ready") {
		suffix = ` · ${resetStr}`;
	} else if (resetStr === "Ready" && width >= 38) {
		suffix = ` · Ready`;
	}

	const rightMargin = 2;
	const gap = 1;
	let barWidth = width - prefix.length - pctStr.length - suffix.length - gap - rightMargin;

	if (barWidth < 4 && suffix) {
		suffix = "";
		barWidth = width - prefix.length - pctStr.length - gap - rightMargin;
	}
	barWidth = Math.max(4, barWidth);

	const filled = Math.round((clamped / 100) * barWidth);
	const empty = Math.max(0, barWidth - filled);

	const bar = panelColor(severityColor, "█".repeat(filled)) + panelDim("░".repeat(empty));
	const pctColored = panelColor(severityColor, pctStr);
	const suffixDim = suffix ? panelDim(suffix) : "";

	return `${panelDim(prefix)}${bar} ${pctColored}${suffixDim}`;
}

export function renderQuotaSidebarPanel(width: number): string[] {
	const safeWidth = Math.max(20, width);
	const lines: string[] = [
		panelBold(" Quota"),
		panelDim("─".repeat(safeWidth)),
	];

	if (cachedAccounts.length === 0) {
		lines.push(panelDim(" (no accounts · run /login antigravity)"));
		return lines;
	}

	if (cachedResults.length === 0) {
		lines.push(panelDim(" (fetching quota…)"));
		return lines;
	}

	const now = Date.now();
	const hasMultiple = cachedResults.length > 1;

	for (let i = 0; i < cachedResults.length; i++) {
		const res = cachedResults[i]!;
		const email = shortEmail(res.email);
		const acc = cachedAccounts.find((a) => a.email === res.email) || cachedAccounts[i];

		if (i > 0) {
			lines.push("");
		}

		const statusDot = !res.success
			? panelColor(PANEL_COLORS.error, "⚠️ error")
			: panelColor(PANEL_COLORS.success, "● OK");
		const accPrefix = hasMultiple ? `[${i + 1}] ` : "";
		const headerTitle = ` ${accPrefix}${email}`;
		const maxTitleLen = Math.max(5, safeWidth - 10);
		const displayTitle = headerTitle.length > maxTitleLen
			? headerTitle.slice(0, maxTitleLen - 1) + "…"
			: headerTitle;
		const padding = Math.max(1, safeWidth - displayTitle.length - 6);
		lines.push(panelColor(PANEL_COLORS.accent, displayTitle) + " ".repeat(padding) + statusDot);

		if (!res.success) {
			lines.push(panelDim("   ") + panelColor(PANEL_COLORS.error, `Error: ${res.error || "lookup failed"}`));
			continue;
		}

		const g5h = findBucket(res.groups, "gemini", "5h", now);
		const gWk = findBucket(res.groups, "gemini", "weekly", now);
		const c5h = findBucket(res.groups, "claude", "5h", now);
		const cWk = findBucket(res.groups, "claude", "weekly", now);

		lines.push(panelDim("  Gemini"));
		lines.push(renderQuotaBarLine("5h", g5h.pct, g5h.resetStr, safeWidth));
		lines.push(renderQuotaBarLine("Wk", gWk.pct, gWk.resetStr, safeWidth));

		lines.push(panelDim("  Claude"));
		lines.push(renderQuotaBarLine("5h", c5h.pct, c5h.resetStr, safeWidth));
		lines.push(renderQuotaBarLine("Wk", cWk.pct, cWk.resetStr, safeWidth));

		if (acc?.rateLimitResetTimes) {
			for (const [family, resetTime] of Object.entries(acc.rateLimitResetTimes)) {
				const remMs = resetTime - now;
				if (remMs > 0) {
					lines.push(
						panelDim("   ") +
						panelColor(PANEL_COLORS.warning, `⚠️ ${family} cooldown: ${formatDuration(remMs)}`),
					);
				}
			}
		}
	}

	return lines;
}

export function isSidebarTuiAvailable(): boolean {
	const g = globalThis as unknown as {
		__PI_SIDEBAR_TUI__?: { isAvailable?: () => boolean };
		__PI_SIDEBAR_PANELS__?: Map<string, unknown>;
	};
	return Boolean(g.__PI_SIDEBAR_TUI__ || g.__PI_SIDEBAR_PANELS__);
}

export function registerQuotaSidebarPanelWithTui(): void {
	const g = globalThis as unknown as {
		__PI_SIDEBAR_TUI__?: { registerPanel?: (panel: unknown) => () => void };
		__PI_SIDEBAR_PANELS__?: Map<string, unknown>;
	};
	const panel = {
		id: "antigravity-quota",
		order: 20, // right below Session (10)
		render: (_ctx: unknown, width: number) => renderQuotaSidebarPanel(width),
	};

	if (typeof g.__PI_SIDEBAR_TUI__?.registerPanel === "function") {
		g.__PI_SIDEBAR_TUI__.registerPanel(panel);
	} else {
		if (!g.__PI_SIDEBAR_PANELS__) {
			g.__PI_SIDEBAR_PANELS__ = new Map();
		}
		g.__PI_SIDEBAR_PANELS__.set("antigravity-quota", panel);
	}
}

export function notifySidebarRender(): void {
	const g = globalThis as unknown as {
		__PI_SIDEBAR_TUI__?: { requestRender?: () => void };
		__PI_SIDEBAR_REQUEST_RENDER__?: () => void;
	};
	if (typeof g.__PI_SIDEBAR_TUI__?.requestRender === "function") {
		g.__PI_SIDEBAR_TUI__.requestRender();
	} else if (typeof g.__PI_SIDEBAR_REQUEST_RENDER__ === "function") {
		g.__PI_SIDEBAR_REQUEST_RENDER__();
	}
}

let cachedResults: AccountQuotaResult[] = [];
let cachedAccounts: ManagedAccount[] = [];
let isStatusActive = false;

export async function refreshCachedQuota(): Promise<{
	results: AccountQuotaResult[];
	accounts: ManagedAccount[];
}> {
	const manager = await getAccountManager();
	const accounts = manager.getAccounts();
	cachedAccounts = accounts;
	if (accounts.length === 0) {
		cachedResults = [];
		notifySidebarRender();
		return { results: [], accounts: [] };
	}

	const results: AccountQuotaResult[] = [];
	for (let i = 0; i < accounts.length; i++) {
		const acc = accounts[i]!;
		if (!acc.enabled) continue;
		if (i > 0) await new Promise((r) => setTimeout(r, 200));
		try {
			const { accessToken } = await manager.getAccessTokenForAccount(acc);
			results.push(await fetchAccountQuota(acc, accessToken));
		} catch (error) {
			results.push({
				email: acc.email || `account #${acc.index + 1}`,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	cachedResults = results;
	notifySidebarRender();
	return { results, accounts };
}

export function applyWidget(_ctx: ExtensionContext) {
	// Deprecated: Quota is now displayed natively in pi-sidebar-tui
}

export function registerQuotaFeature(pi: ExtensionAPI, _providerId = ANTIGRAVITY_PROVIDER_ID) {
	// Register quota panel into pi-sidebar-tui
	registerQuotaSidebarPanelWithTui();

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			if (!isSidebarTuiAvailable()) {
				ctx.ui.notify(
					"Antigravity Quota: pi-sidebar-tui is required for sidebar quota display. Install and enable pi-sidebar-tui to view quota.",
					"warning",
				);
			}
			const manager = await getAccountManager();
			cachedAccounts = manager.getAccounts();
			notifySidebarRender();
			const { results } = await refreshCachedQuota();
			notifySidebarRender();
			if (isStatusActive) {
				ctx.ui.setStatus("antigravity-quota", formatQuotaStatusText(results));
			}
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const { results } = await refreshCachedQuota();
		notifySidebarRender();
		if (isStatusActive) {
			ctx.ui.setStatus("antigravity-quota", formatQuotaStatusText(results));
		}
	});

	// Tool: antigravity_quota
	pi.registerTool({
		name: "antigravity_quota",
		label: "Antigravity Quota",
		description:
			"Check Antigravity / Google Cloud Code Assist model quota and local rate limits for all configured accounts",
		promptSnippet: "Check Antigravity model quota and rate limits across Google accounts",
		promptGuidelines: [
			"Use antigravity_quota when the user asks about remaining Antigravity/Google quota, Claude/Gemini usage limits, or rate limits.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: "Fetching Antigravity quota..." }],
				details: {},
			});
			const { results, accounts } = await refreshCachedQuota();
			if (accounts.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No Antigravity accounts configured. Run `/login antigravity` first.",
						},
					],
					details: { accounts: 0 },
				};
			}

			const report = formatQuotaReport(results, accounts);
			return {
				content: [{ type: "text", text: report }],
				details: { results },
			};
		},
	});

	// Tool: antigravity_search (Google Grounding)
	pi.registerTool({
		name: "antigravity_search",
		label: "Google Web Search",
		description:
			"Search the web using Google Search grounding via Antigravity Gemini models. Supports queries and specific URLs.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to analyze" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Searching Google for: "${params.query}"...` }],
				details: {},
			});
			const manager = await getAccountManager();
			const account = manager.selectAccount("gemini-2.5-flash");
			if (!account) {
				return {
					content: [{ type: "text", text: "Error: No active Antigravity account available for search." }],
					details: { error: "no_account" },
				};
			}
			const { accessToken, projectId } = await manager.getAccessTokenForAccount(account, signal);
			const resultText = await executeSearch(
				{ query: params.query, urls: params.urls },
				accessToken,
				projectId || "rising-fact-p41fc",
				signal,
			);
			return { content: [{ type: "text", text: resultText }], details: {} };
		},
	});

	// Command: /quota and /antigravity-quota
	const quotaCommandHandler = async (args: string, ctx: ExtensionContext) => {
		const subcmd = args.trim().toLowerCase();

		if (subcmd === "status" || subcmd === "toggle-status") {
			isStatusActive = !isStatusActive;
			if (isStatusActive && ctx.hasUI) {
				ctx.ui.notify("Enabling footer quota status...", "info");
				const { results } = await refreshCachedQuota();
				ctx.ui.setStatus("antigravity-quota", formatQuotaStatusText(results));
				ctx.ui.notify("Quota status enabled in footer.", "info");
			} else if (ctx.hasUI) {
				ctx.ui.setStatus("antigravity-quota", undefined);
				ctx.ui.notify("Quota status removed from footer.", "info");
			}
			return;
		}

		if (subcmd === "report" || subcmd === "full" || subcmd === "table") {
			ctx.ui.notify("Fetching full Antigravity quota report...", "info");
			const { results, accounts } = await refreshCachedQuota();
			if (accounts.length === 0) {
				ctx.ui.notify(
					"No Antigravity accounts configured. Run `/login antigravity` first.",
					"warning",
				);
				return;
			}

			const report = formatQuotaReport(results, accounts);
			if (ctx.hasUI) {
				await ctx.ui.editor("Antigravity Quota Status", report);
			} else {
				ctx.ui.notify(report, "info");
			}
			return;
		}

		// Default behavior: check/refresh quota in sidebar
		if (ctx.hasUI && !isSidebarTuiAvailable()) {
			ctx.ui.notify(
				"Antigravity Quota requires pi-sidebar-tui to display quota in the sidebar. Run `pi install /path/to/pi-sidebar-tui` to install it.",
				"warning",
			);
		}

		ctx.ui.notify("Refreshing Antigravity quota in sidebar...", "info");
		const { accounts } = await refreshCachedQuota();
		if (accounts.length === 0) {
			ctx.ui.notify(
				"No Antigravity accounts configured. Run `/login antigravity` first.",
				"warning",
			);
			return;
		}

		notifySidebarRender();
		if (ctx.hasUI) {
			ctx.ui.notify("Quota refreshed in sidebar. Run `/quota report` for full breakdown table.", "info");
		}
	};

	pi.registerCommand("quota", {
		description: "Check Antigravity API quotas in sidebar. Subcommands: 'report' (full table), 'status' (footer)",
		handler: quotaCommandHandler,
	});

	pi.registerCommand("antigravity-quota", {
		description: "Check Antigravity API quotas in sidebar. Subcommands: 'report' (full table), 'status' (footer)",
		handler: quotaCommandHandler,
	});

	// Command: /antigravity-accounts (Account Management)
	pi.registerCommand("antigravity-accounts", {
		description: "Manage Antigravity Google accounts (list, toggle, verify, remove)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const manager = await getAccountManager();
			const accounts = manager.getAccounts();

			if (accounts.length === 0) {
				ctx.ui.notify("No Antigravity accounts found. Run `/login antigravity` to add one.", "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(getLocalRateLimitInfo(accounts), "info");
				return;
			}

			const options = accounts.map((acc, index) => {
				const emailStr = acc.email || `Account #${index + 1}`;
				let statusStr = acc.enabled ? "✅ Enabled" : "⏸️ Disabled";
				if (acc.verificationRequired) statusStr = "⚠️ Needs Verification";
				return {
					id: String(index),
					label: `${emailStr} [${statusStr}]`,
				};
			});

			options.push({ id: "add", label: "➕ Add another account" });
			options.push({ id: "cancel", label: "❌ Close" });

			const selectedId = await ctx.ui.select("Select an account to manage:", options.map((o) => o.label));
			if (!selectedId || selectedId.includes("Close")) return;

			if (selectedId.includes("Add another account")) {
				ctx.ui.notify("Starting OAuth authorization in your browser...", "info");
				try {
					const listener = await startOAuthListener();
					const { url } = await authorizeAntigravity();
					openBrowser(url);
					ctx.ui.notify("Waiting for Google sign in...", "info");
					const callbackUrl = await listener.waitForCallback();
					const code = callbackUrl.searchParams.get("code");
					const state = callbackUrl.searchParams.get("state");
					if (code && state) {
						const tokens = await exchangeAntigravity(code, state);
						await manager.upsertAccount({
							email: tokens.email,
							refreshToken: tokens.refresh.split("|")[0] ?? "",
							projectId: tokens.refresh.split("|")[1] || undefined,
						});
						ctx.ui.notify(`Successfully added account ${tokens.email ?? ""}!`, "info");
					}
					await listener.close().catch(() => {});
				} catch (err) {
					ctx.ui.notify(`Failed to add account: ${String(err)}`, "error");
				}
				return;
			}

			const matchedIndex = options.findIndex((o) => o.label === selectedId);
			if (matchedIndex < 0 || matchedIndex >= accounts.length) return;

			const targetAccount = accounts[matchedIndex]!;
			const actions = [
				targetAccount.enabled ? "⏸️ Disable Account" : "▶️ Enable Account",
				targetAccount.verificationRequired ? "✅ Clear Verification Status" : "🔍 Probe Verification",
				"🗑️ Remove Account",
				"❌ Back",
			];

			const actionChoice = await ctx.ui.select(
				`Manage ${targetAccount.email || `Account #${targetAccount.index + 1}`}:`,
				actions,
			);

			if (!actionChoice || actionChoice.includes("Back")) return;

			if (actionChoice.includes("Disable Account")) {
				manager.setAccountEnabled(targetAccount.index, false);
				ctx.ui.notify(`Disabled account ${targetAccount.email || `#${targetAccount.index + 1}`}`, "info");
			} else if (actionChoice.includes("Enable Account")) {
				manager.setAccountEnabled(targetAccount.index, true);
				ctx.ui.notify(`Enabled account ${targetAccount.email || `#${targetAccount.index + 1}`}`, "info");
			} else if (actionChoice.includes("Clear Verification Status")) {
				manager.clearAccountVerification(targetAccount);
				ctx.ui.notify(`Cleared verification status for account ${targetAccount.email || `#${targetAccount.index + 1}`}`, "info");
			} else if (actionChoice.includes("Probe Verification")) {
				ctx.ui.notify("Testing token validity...", "info");
				try {
					await manager.getAccessTokenForAccount(targetAccount);
					ctx.ui.notify("Account credentials are valid and active!", "info");
				} catch (err) {
					ctx.ui.notify(`Token probe failed: ${String(err)}`, "error");
				}
			} else if (actionChoice.includes("Remove Account")) {
				const confirm = await ctx.ui.confirm(
					"Confirm Removal",
					`Are you sure you want to remove ${targetAccount.email || `Account #${targetAccount.index + 1}`}?`,
				);
				if (confirm) {
					await manager.removeAccount(targetAccount.index);
					ctx.ui.notify(`Removed account ${targetAccount.email || `#${targetAccount.index + 1}`}`, "info");
				}
			}
		},
	});

	// Command: /antigravity-add-account
	pi.registerCommand("antigravity-add-account", {
		description: "Add an extra Google Antigravity account via OAuth",
		handler: async (_args: string, ctx: ExtensionContext) => {
			ctx.ui.notify("Starting OAuth authorization in your browser...", "info");
			try {
				const listener = await startOAuthListener();
				const { url } = await authorizeAntigravity();
				openBrowser(url);
				ctx.ui.notify("Waiting for Google sign in...", "info");
				const callbackUrl = await listener.waitForCallback();
				const code = callbackUrl.searchParams.get("code");
				const state = callbackUrl.searchParams.get("state");
				if (!code || !state) throw new Error("Missing code or state parameter");
				const tokens = await exchangeAntigravity(code, state);
				const manager = await getAccountManager();
				await manager.upsertAccount({
					email: tokens.email,
					refreshToken: tokens.refresh.split("|")[0] ?? "",
					projectId: tokens.refresh.split("|")[1] || undefined,
				});
				ctx.ui.notify(`Successfully added account ${tokens.email ?? ""}!`, "info");
				await listener.close().catch(() => {});
			} catch (err) {
				ctx.ui.notify(`Failed to add account: ${String(err)}`, "error");
			}
		},
	});
}

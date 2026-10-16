#!/usr/bin/env npx tsx
/**
 * CLI tool to inspect Antigravity Quotas across accounts.
 * Reads credentials dynamically from antigravity-accounts.json.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/check-quota.ts [--account <index>] [--path <custom-path>]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadAccounts, getStoragePath } from "../src/storage.js";
import { refreshAccessToken } from "../src/auth.js";
import { loadCodeAssist, extractProjectId, fetchUserQuotaSummary, fetchLocalLanguageServerQuota, type QuotaGroup } from "../src/quota.js";
import {
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../src/constants.js";
import { progressBar, formatDuration } from "../src/logging-utils.js";

function parseArgs(): { path?: string; accountIndex?: number } {
	const args = process.argv.slice(2);
	let customPath: string | undefined;
	let accountIndex: number | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--path" && args[i + 1]) {
			customPath = args[i + 1];
			i++;
		} else if (args[i] === "--account" && args[i + 1]) {
			accountIndex = parseInt(args[i + 1]!, 10) - 1;
			i++;
		}
	}
	return { path: customPath, accountIndex };
}

async function main() {
	const { path: customPath, accountIndex } = parseArgs();

	let accounts: Array<{
		email?: string;
		refreshToken: string;
		projectId?: string;
		managedProjectId?: string;
		enabled?: boolean;
	}> = [];

	if (customPath) {
		if (!existsSync(customPath)) {
			console.error(`Specified accounts file does not exist: ${customPath}`);
			process.exit(1);
		}
		const data = JSON.parse(readFileSync(customPath, "utf-8"));
		accounts = data.accounts || [];
	} else {
		const storage = await loadAccounts();
		accounts = storage.accounts;
		if (accounts.length === 0) {
			const opPath = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
			if (existsSync(opPath)) {
				try {
					const opData = JSON.parse(readFileSync(opPath, "utf-8"));
					accounts = opData.accounts || [];
				} catch {}
			}
		}
	}

	if (accounts.length === 0) {
		console.error("No accounts found in antigravity-accounts.json");
		console.error(`Storage path: ${getStoragePath()}`);
		process.exit(1);
	}

	const selected = accountIndex !== undefined
		? accounts.map((acc, idx) => ({ acc, idx })).filter((x) => x.idx === accountIndex)
		: accounts.map((acc, idx) => ({ acc, idx }));

	const now = Date.now();

	for (const { acc, idx } of selected) {
		const label = acc.email || `Account #${idx + 1}`;
		const disabled = acc.enabled === false ? " [DISABLED]" : "";
		console.log(`\n========================================`);
		console.log(`Account ${idx + 1}: ${label}${disabled}`);
		console.log(`========================================`);

		if (!acc.refreshToken) {
			console.log("  ⚠️ Missing refresh token.");
			continue;
		}

		try {
			const { accessToken } = await refreshAccessToken(acc.refreshToken);

			let projectId = acc.managedProjectId || acc.projectId;
			if (!projectId) {
				try {
					const codeAssist = await loadCodeAssist(accessToken);
					projectId = extractProjectId(codeAssist.cloudaicompanionProject);
				} catch {}
			}
			if (!projectId) {
				projectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
			}
			console.log(`  Project: ${projectId}\n`);

			let groups: QuotaGroup[] = [];
			try {
				const localQuota = await fetchLocalLanguageServerQuota();
				if (localQuota?.groups && localQuota.groups.length > 0) {
					groups = localQuota.groups;
					console.log("  Source: Live Antigravity Language Server\n");
				}
			} catch {}

			if (groups.length === 0) {
				const quotaData = await fetchUserQuotaSummary(accessToken, projectId);
				groups = quotaData.groups || [];
			}

			if (groups.length === 0) {
				console.log("  No quota groups returned by API.");
				continue;
			}

			for (const group of groups) {
				console.log(`  📊 ${group.displayName}`);
				for (const bucket of group.buckets) {
					const pct = Math.round(bucket.remainingFraction * 100);
					let resetStr = "Ready";
					if (pct < 100 && bucket.resetTime) {
						const rem = new Date(bucket.resetTime).getTime() - now;
						resetStr = rem > 0 ? formatDuration(rem) : "Ready";
					}
					const bar = progressBar(pct);
					console.log(`     ${bucket.displayName.padEnd(20)} ${bar} ${String(pct).padStart(3)}%   (Reset: ${resetStr})`);
				}
				console.log();
			}
		} catch (err) {
			console.log(`  ❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

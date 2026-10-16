#!/usr/bin/env npx tsx
/**
 * Fetch available models from Antigravity endpoints.
 * Reads credentials dynamically from antigravity-accounts.json.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/fetch-models.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadAccounts, getStoragePath } from "../src/storage.js";
import { refreshAccessToken } from "../src/auth.js";
import { loadCodeAssist, extractProjectId } from "../src/quota.js";
import {
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../src/constants.js";

async function main() {
	// 1. Load accounts strictly from the JSON file
	let storage = await loadAccounts();
	let account = storage.accounts[0];

	// Fallback to opencode json if pi accounts are empty
	if (!account) {
		const opPath = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
		if (existsSync(opPath)) {
			try {
				const opData = JSON.parse(readFileSync(opPath, "utf-8"));
				account = opData.accounts?.[0];
			} catch {}
		}
	}

	if (!account?.refreshToken) {
		console.error("No account or refreshToken found in antigravity-accounts.json");
		console.error(`Checked path: ${getStoragePath()}`);
		process.exit(1);
	}

	const accountLabel = account.email || "Account 1";
	console.log(`Using account from JSON: ${accountLabel}`);

	// 2. Exchange refresh token for fresh access token via auth module
	const { accessToken } = await refreshAccessToken(account.refreshToken);
	console.log("Authenticated successfully via refresh token from JSON.\n");

	// 3. Resolve project ID
	let effectiveProjectId = account.managedProjectId || account.projectId;
	if (!effectiveProjectId) {
		try {
			const ca = await loadCodeAssist(accessToken);
			effectiveProjectId = extractProjectId(ca.cloudaicompanionProject);
		} catch {}
	}
	if (!effectiveProjectId) {
		effectiveProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
	}

	console.log(`Project ID: ${effectiveProjectId}\n`);

	// 4. Fetch available models from both endpoints
	const endpoints = [
		{ name: "Production", url: ANTIGRAVITY_ENDPOINT_PROD },
		{ name: "Daily Sandbox", url: ANTIGRAVITY_ENDPOINT_DAILY },
	];

	for (const ep of endpoints) {
		console.log(`=== ${ep.name} (${ep.url}) ===`);
		try {
			const res = await fetch(`${ep.url}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.19.4 windows/amd64",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
					"Client-Metadata": JSON.stringify({
						ideType: "ANTIGRAVITY",
						platform: "WINDOWS",
						pluginType: "GEMINI",
					}),
				},
				body: JSON.stringify({ project: effectiveProjectId }),
			});

			if (!res.ok) {
				const err = await res.text();
				console.error(`  Failed: ${res.status} ${err.slice(0, 200)}`);
				continue;
			}

			const data = (await res.json()) as {
				models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number } }>;
			};
			const models = data.models ?? {};
			const keys = Object.keys(models);
			console.log(`  Found ${keys.length} models:`);
			for (const key of keys) {
				const m = models[key]!;
				const display = m.displayName ?? "(no display name)";
				const remaining =
					m.quotaInfo?.remainingFraction !== undefined
						? ` [quota: ${Math.round(m.quotaInfo.remainingFraction * 100)}%]`
						: "";
				console.log(`    - ${key.padEnd(30)} -> ${display}${remaining}`);
			}
		} catch (err) {
			console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		}
		console.log();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

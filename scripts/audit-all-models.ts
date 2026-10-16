#!/usr/bin/env npx tsx
/**
 * Audit all Antigravity models and endpoints to check which are active/deprecated.
 * Reads credentials dynamically from antigravity-accounts.json.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/audit-all-models.ts
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
	// 1. Load accounts strictly from JSON
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

	// 2. Refresh token via plugin auth module
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

	// 4. Audit root endpoints
	const endpoints = [
		{ name: "Production", url: ANTIGRAVITY_ENDPOINT_PROD },
		{ name: "Daily Sandbox", url: ANTIGRAVITY_ENDPOINT_DAILY },
	];

	console.log("==========================================");
	console.log("1. AUDITING ROOT ENDPOINTS");
	console.log("==========================================");

	for (const ep of endpoints) {
		console.log(`\nTesting endpoint: ${ep.name} (${ep.url})`);
		try {
			const res = await fetch(`${ep.url}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.19.4 windows/amd64",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
					"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" }),
				},
				body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" } }),
			});
			const body = (await res.json().catch(() => ({}))) as { cloudaicompanionProject?: unknown };
			console.log(`  loadCodeAssist: status=${res.status} ok=${res.ok} hasProject=${!!body.cloudaicompanionProject}`);
		} catch (err) {
			console.log(`  loadCodeAssist: error=${err instanceof Error ? err.message : String(err)}`);
		}

		try {
			const res = await fetch(`${ep.url}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.19.4 windows/amd64",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
					"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" }),
				},
				body: JSON.stringify({ project: effectiveProjectId }),
			});
			const body = (await res.json().catch(() => ({}))) as { models?: Record<string, unknown> };
			const count = Object.keys(body.models || {}).length;
			console.log(`  fetchAvailableModels: status=${res.status} ok=${res.ok} modelCount=${count}`);
		} catch (err) {
			console.log(`  fetchAvailableModels: error=${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// 5. Test model candidates
	const modelsToTest = [
		// Current / New Gemini Models
		{ id: "gemini-3.8-flash-tiered", label: "Gemini 3.8 Flash Tiered", thinkingLevel: "low" },
		{ id: "gemini-3-flash", label: "Gemini 3 Flash", thinkingLevel: "low" },
		{ id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
		{ id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
		{ id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Medium)" },
		{ id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
		{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },

		// Current / New Claude 5.5 Models
		{ id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
		{ id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
		{ id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
		{ id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },

		// GPT-OSS
		{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },

		// Deprecated / Discontinued Models
		{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Deprecated check)" },
		{ id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Deprecated check)" },
		{ id: "gemini-3.7-flash-tiered", label: "Gemini 3.7 Flash Tiered (Deprecated check)" },
		{ id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash Low (Deprecated check)" },
	];

	console.log("\n==========================================");
	console.log("2. AUDITING CANDIDATE MODELS");
	console.log("==========================================");

	const results = [];
	const targetEndpoint = ANTIGRAVITY_ENDPOINT_DAILY;

	for (const m of modelsToTest) {
		const requestPayload: Record<string, unknown> = {
			contents: [{ role: "user", parts: [{ text: "Hello! Reply with 1 word." }] }],
		};
		if (m.thinkingLevel) {
			requestPayload.generationConfig = {
				thinkingConfig: { thinkingLevel: m.thinkingLevel },
			};
		}

		const envelope = {
			project: effectiveProjectId,
			model: m.id,
			request: requestPayload,
			userAgent: "antigravity",
			requestId: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		};

		try {
			const res = await fetch(`${targetEndpoint}/v1internal:generateContent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.19.4 win32/x64",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
					"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" }),
				},
				body: JSON.stringify(envelope),
			});

			const text = await res.text();
			let parsed: any = null;
			try { parsed = JSON.parse(text); } catch {}

			const sampleText =
				parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
				parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
				"";

			const isDeprecatedMessage = sampleText.toLowerCase().includes("no longer available");
			const success = res.ok && !isDeprecatedMessage && sampleText.length > 0;
			const errorMsg = !res.ok
				? (parsed?.error?.message || text.slice(0, 150))
				: (isDeprecatedMessage ? sampleText : "");

			results.push({
				id: m.id,
				label: m.label,
				status: res.status,
				success: success ? "YES" : (isDeprecatedMessage ? "DEPRECATED" : "NO"),
				response: sampleText.slice(0, 50).replace(/\n/g, " "),
				error: errorMsg.slice(0, 60),
			});

			const statusIcon = success ? "✅ PASS" : (isDeprecatedMessage ? "⚠️ DEPR" : "❌ FAIL");
			console.log(`${statusIcon} ${m.id.padEnd(28)} (status ${res.status}): ${sampleText.slice(0, 60).replace(/\n/g, " ") || errorMsg}`);
		} catch (err) {
			console.log(`❌ EXCEPTION ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
			results.push({
				id: m.id,
				label: m.label,
				status: "EXC",
				success: "NO",
				response: "",
				error: (err instanceof Error ? err.message : String(err)).slice(0, 60),
			});
		}
	}

	console.log("\n==========================================");
	console.log("SUMMARY REPORT");
	console.log("==========================================");
	console.table(results.map((r) => ({
		Model: r.id,
		Status: r.status,
		Active: r.success,
		Details: r.response || r.error,
	})));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

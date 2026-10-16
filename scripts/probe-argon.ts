#!/usr/bin/env npx tsx
import { loadAccounts } from "../src/storage.js";
import { refreshAccessToken } from "../src/auth.js";
import {
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../src/constants.js";

async function main() {
	const storage = await loadAccounts();
	const account = storage.accounts[0];
	if (!account?.refreshToken) {
		console.error("No account found");
		process.exit(1);
	}

	const { accessToken } = await refreshAccessToken(account.refreshToken);
	const projectId = account.managedProjectId || account.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;

	console.log(`Probing endpoints for Gemini 4 / Argon with account: ${account.email} (Project: ${projectId})\n`);

	// 1. Check fetchAvailableModels
	for (const ep of [ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_ENDPOINT_DAILY]) {
		const res = await fetch(`${ep}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": "antigravity/1.19.4 windows/amd64",
				"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
				"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" }),
			},
			body: JSON.stringify({ project: projectId }),
		});
		if (res.ok) {
			const data = (await res.json()) as { models?: Record<string, unknown> };
			const models = data.models || {};
			console.log(`[${ep}] Total models returned: ${Object.keys(models).length}`);
			const matches = Object.keys(models).filter(
				(k) =>
					k.toLowerCase().includes("argon") ||
					k.toLowerCase().includes("gemini-4") ||
					JSON.stringify(models[k]).toLowerCase().includes("argon") ||
					JSON.stringify(models[k]).toLowerCase().includes("gemini-4")
			);
			if (matches.length > 0) {
				console.log(`  Found matches in catalog: ${matches.join(", ")}`);
			} else {
				console.log("  No matches for 'argon' or 'gemini-4' in catalog.");
			}
		} else {
			console.log(`[${ep}] fetchAvailableModels failed: ${res.status}`);
		}
	}

	// 2. Direct probe against v1internal:generateContent on Daily Sandbox
	const candidateModels = [
		"gemini-4-argon",
		"gemini-4-argon-flash",
		"gemini-4-argon-pro",
		"gemini-4",
		"gemini-4.0",
		"gemini-4.0-flash",
		"gemini-4.0-pro",
		"gemini-4-flash",
		"gemini-4-pro",
		"argon",
		"argon-flash",
		"argon-pro",
		"gemini-argon",
		// Also test reference working models on the same endpoint to confirm endpoint behavior
		"gemini-3.8-flash-tiered",
		"claude-sonnet-5-5-high",
		"claude-opus-5-5-high",
	];

	console.log("\nProbing candidate model IDs directly via v1internal:generateContent (Daily Sandbox)...");

	for (const modelId of candidateModels) {
		const envelope = {
			project: projectId,
			model: modelId,
			request: {
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
			},
			userAgent: "antigravity",
			requestId: `probe-${Date.now()}`,
		};

		try {
			const res = await fetch(`${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`, {
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

			if (res.ok) {
				const sample =
					parsed?.candidates?.[0]?.content?.parts?.[0]?.text ||
					parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
				console.log(`  ✅ ${modelId.padEnd(25)}: STATUS 200 -> "${sample?.slice(0, 40).replace(/\n/g, " ")}"`);
			} else {
				const errMsg = parsed?.error?.message || text.slice(0, 100);
				console.log(`  ❌ ${modelId.padEnd(25)}: STATUS ${res.status} -> ${errMsg.slice(0, 60)}`);
			}
		} catch (e) {
			console.log(`  ❌ ${modelId.padEnd(25)}: Error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	console.log("\nProbe complete.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

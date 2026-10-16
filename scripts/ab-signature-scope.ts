#!/usr/bin/env npx tsx
/**
 * Live A/B test: is a Gemini-3 `thoughtSignature` portable across GCP projects/accounts?
 * Reads credentials dynamically from antigravity-accounts.json.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/ab-signature-scope.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadAccounts, type StoredAccountV4 } from "../src/storage.js";
import { refreshAccessToken } from "../src/auth.js";
import {
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
	getRandomizedAntigravityHeaders,
} from "../src/constants.js";

const MODEL = "gemini-3-flash";
const ENDPOINT = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`;
const PROMPT = "Use the multiply tool to compute 17 times 23. You must call the tool.";
const TOOLS = [
	{
		functionDeclarations: [
			{
				name: "multiply",
				description: "Multiply two integers and return the product.",
				parameters: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
			},
		],
	},
];

interface Account {
	index: number;
	email: string;
	accessToken: string;
	projectId: string;
}

async function bootstrap(acc: StoredAccountV4, index: number): Promise<Account | null> {
	if (!acc.refreshToken) return null;
	try {
		const { accessToken } = await refreshAccessToken(acc.refreshToken);
		const projectId =
			acc.managedProjectId ?? acc.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;
		return { index, email: acc.email ?? `account-${index}`, accessToken, projectId };
	} catch {
		return null;
	}
}

async function sendTurn1(account: Account): Promise<{
	status: number;
	thoughtText: string;
	signature?: string;
	callArgs?: any;
	error?: string;
}> {
	const body = {
		project: account.projectId,
		model: MODEL,
		request: {
			model: MODEL,
			contents: [{ role: "user", parts: [{ text: PROMPT }] }],
			tools: TOOLS,
			generationConfig: {
				maxOutputTokens: 1024,
				temperature: 0,
				thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
			},
		},
	};
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			...getRandomizedAntigravityHeaders(),
			Authorization: `Bearer ${account.accessToken}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		return { status: res.status, thoughtText: "", error: text.slice(0, 200) };
	}
	let thoughtText = "";
	let signature: string | undefined;
	let callArgs: any;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const json = line.slice(5).trim();
		if (!json) continue;
		let evt: any;
		try { evt = JSON.parse(json); } catch { continue; }
		const parts = (evt?.response?.candidates ?? evt?.candidates)?.[0]?.content?.parts ?? [];
		for (const p of parts) {
			if (p.thought === true && typeof p.text === "string") thoughtText += p.text;
			if (p.functionCall) callArgs = p.functionCall.args;
			const sig = p.thoughtSignature ?? p?.metadata?.google?.thoughtSignature;
			if (sig) signature = sig;
		}
	}
	return { status: res.status, thoughtText, signature, callArgs };
}

async function main() {
	console.log("=== Thought Signature Scope Probe ===");
	let storage = await loadAccounts();
	let storedAccounts = storage.accounts;
	if (storedAccounts.length === 0) {
		const opPath = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
		if (existsSync(opPath)) {
			try {
				const opData = JSON.parse(readFileSync(opPath, "utf-8"));
				storedAccounts = opData.accounts || [];
			} catch {}
		}
	}

	const accounts: Account[] = [];
	for (let i = 0; i < storedAccounts.length; i++) {
		const acc = await bootstrap(storedAccounts[i]!, i);
		if (acc) accounts.push(acc);
	}
	console.log(`Bootstrapped ${accounts.length} valid accounts from JSON.`);

	if (accounts.length === 0) {
		console.log("No valid accounts to probe.");
		process.exit(1);
	}

	for (const acc of accounts) {
		console.log(`Testing turn 1 on ${acc.email} (${acc.projectId})...`);
		const t1 = await sendTurn1(acc);
		console.log(`  status: ${t1.status}, signature: ${t1.signature ? `${t1.signature.length} chars` : "none"}`);
	}
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});

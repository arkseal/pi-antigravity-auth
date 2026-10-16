#!/usr/bin/env npx tsx
/**
 * Behavioral probe: does restoring the real Gemini-3 thoughtSignature stop the
 * model re-planning (the Loop symptom)?
 *
 * Controlled single-account A/B on a 2-step tool task (list_files -> read_file):
 *   Turn 1: model calls list_files, returns a thoughtSignature.
 *   Provide the file list as a functionResponse, then replay turn-2 TWO ways:
 *     - FIX arm    : functionCall carries the REAL restored signature
 *     - SENTINEL arm: functionCall carries skip_thought_signature_validator
 *   Observe the model's next move each way:
 *     - read_file (or final answer using listing) = PROGRESSED (continuity held)
 *     - list_files again                          = RE-PLANNED (lost continuity)
 *
 * Reads credentials dynamically from antigravity-accounts.json.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/signature-continuity-probe.ts
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
	SKIP_THOUGHT_SIGNATURE,
} from "../src/constants.js";

const MODEL = "gemini-3-flash";
const ENDPOINT = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`;
const SENTINEL = SKIP_THOUGHT_SIGNATURE;
const RUNS = 2;

const PROMPT =
	"You are exploring a repo. Work step by step using the tools. " +
	"First call list_files to see what's there. After you receive the listing, " +
	"call read_file on the FIRST file in the list. Do not call list_files more than once.";

const TOOLS = [
	{
		functionDeclarations: [
			{ name: "list_files", description: "List files in the repository.", parameters: { type: "object", properties: {} } },
			{
				name: "read_file",
				description: "Read the contents of one file.",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		],
	},
];
const FILE_LISTING = ["alpha.md", "beta.md", "gamma.md"];

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

interface TurnResult {
	status: number;
	ok: boolean;
	thoughtText: string;
	signature?: string;
	functionCalls: { name: string; args: any }[];
	errorMessage?: string;
}

async function sendTurn(account: Account, contents: any[]): Promise<TurnResult> {
	const body = {
		project: account.projectId,
		model: MODEL,
		request: {
			model: MODEL,
			contents,
			tools: TOOLS,
			generationConfig: {
				maxOutputTokens: 2048,
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
	const out: TurnResult = { status: res.status, ok: res.ok, thoughtText: "", functionCalls: [] };
	if (!res.ok) {
		try {
			out.errorMessage = JSON.parse(text)?.error?.message ?? text.slice(0, 300);
		} catch {
			out.errorMessage = text.slice(0, 300);
		}
		return out;
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const json = line.slice(5).trim();
		if (!json) continue;
		let evt: any;
		try {
			evt = JSON.parse(json);
		} catch {
			continue;
		}
		const parts = (evt?.response?.candidates ?? evt?.candidates)?.[0]?.content?.parts ?? [];
		for (const p of parts) {
			if (p.thought === true && typeof p.text === "string") out.thoughtText += p.text;
			if (p.functionCall) out.functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args });
			const sig = p.thoughtSignature ?? p?.metadata?.google?.thoughtSignature;
			if (sig) out.signature = sig;
		}
	}
	return out;
}

function turn2History(t1: TurnResult, sig: string): any[] {
	const modelParts: any[] = [];
	if (t1.thoughtText) modelParts.push({ thought: true, text: t1.thoughtText, thoughtSignature: sig });
	modelParts.push({ functionCall: { name: "list_files", args: {} }, thoughtSignature: sig });
	return [
		{ role: "user", parts: [{ text: PROMPT }] },
		{ role: "model", parts: modelParts },
		{
			role: "function",
			parts: [
				{
					functionResponse: {
						name: "list_files",
						response: { output: FILE_LISTING.join("\n") },
					},
				},
			],
		},
	];
}

function classifyMove(r: TurnResult): { label: string; progressed: boolean | null } {
	if (!r.ok) return { label: `ERROR (${r.status}): ${r.errorMessage}`, progressed: null };
	const calls = r.functionCalls.map((c) => c.name);
	if (calls.includes("read_file")) {
		const target = r.functionCalls.find((c) => c.name === "read_file")?.args?.path;
		return { label: `called read_file("${target}") → PROGRESSED`, progressed: true };
	}
	if (calls.includes("list_files")) {
		return { label: `re-called list_files → RE-PLANNED (Loop)`, progressed: false };
	}
	if (calls.length === 0 && r.thoughtText) {
		return { label: `no tool calls, text only → PROGRESSED (final answer)`, progressed: true };
	}
	return { label: `other tool calls (${calls.join(",") || "none"})`, progressed: null };
}

async function main() {
	console.log("=== Signature Continuity Behavioral Probe ===");
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

	console.log("Acquiring Turn 1 baseline...");
	let acct: Account | null = null;
	let t1: TurnResult | null = null;
	for (const cand of accounts) {
		const r = await sendTurn(cand, [{ role: "user", parts: [{ text: PROMPT }] }]);
		if (r.status === 429) {
			console.log(`  [${cand.index}] ${cand.email}: 429 quota — skip`);
			continue;
		}
		if (r.ok && r.signature && r.functionCalls.some((f) => f.name === "list_files")) {
			acct = cand;
			t1 = r;
			console.log(`  ✓ account [${cand.index}] ${cand.email}; turn-1 → list_files, signature ${r.signature.length} chars`);
			break;
		}
		console.log(`  [${cand.index}] ${cand.email}: turn-1 unsuitable (ok=${r.ok}, sig=${!!r.signature}, calls=${r.functionCalls.map((f) => f.name).join(",") || "none"}) — skip`);
	}

	if (!acct || !t1 || !t1.signature) {
		console.log("\nINCONCLUSIVE — no quota-available account produced a turn-1 list_files+signature.");
		process.exit(0);
	}

	const realSig = t1.signature;
	const fixHistory = turn2History(t1, realSig);
	const sentinelHistory = turn2History(t1, SENTINEL);

	const tally = { fix: { progressed: 0, replanned: 0, other: 0 }, sentinel: { progressed: 0, replanned: 0, other: 0 } };

	for (let run = 1; run <= RUNS; run++) {
		console.log(`\n--- Run ${run}/${RUNS} ---`);
		const fix = classifyMove(await sendTurn(acct, fixHistory));
		console.log(`  FIX (real signature):      ${fix.label}`);
		if (fix.progressed === true) tally.fix.progressed++;
		else if (fix.progressed === false) tally.fix.replanned++;
		else tally.fix.other++;

		const sen = classifyMove(await sendTurn(acct, sentinelHistory));
		console.log(`  SENTINEL (old behavior):   ${sen.label}`);
		if (sen.progressed === true) tally.sentinel.progressed++;
		else if (sen.progressed === false) tally.sentinel.replanned++;
		else tally.sentinel.other++;
	}

	console.log(`\n=== TALLY (over ${RUNS} runs) ===`);
	console.log(`  FIX (real sig):  progressed=${tally.fix.progressed} replanned=${tally.fix.replanned} other=${tally.fix.other}`);
	console.log(`  SENTINEL (old):  progressed=${tally.sentinel.progressed} replanned=${tally.sentinel.replanned} other=${tally.sentinel.other}`);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});

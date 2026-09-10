/**
 * Comprehensive test suite for pi-antigravity-auth ported features.
 * Tests:
 * - Math formatting (LaTeX to Unicode + MathStreamBuffer)
 * - Model resolution (Gemini 3.8, 3.7, 3.6, 3.5, 3.1, Claude, Image)
 * - Storage V4 schema, lockfile, migrations
 * - AccountManager & HealthScoreTracker & TokenBucketTracker
 * - Device fingerprinting & version updating
 * - Cross-model metadata sanitization
 * - Claude & Gemini transforms
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latexToUnicode, MathStreamBuffer } from "../src/math/index.js";
import {
	resolveBackendModel,
	getModelFamily,
	isClaudeModel,
	isClaudeThinkingModel,
	isImageGenerationModel,
} from "../src/model-resolver.js";
import {
	generateFingerprint,
	updateFingerprintVersion,
	buildFingerprintHeaders,
} from "../src/fingerprint.js";
import { HealthScoreTracker, TokenBucketTracker, selectHybridAccount } from "../src/rotation.js";
import { AccountManager } from "../src/accounts.js";
import {
	saveAccounts,
	saveAccountsReplace,
	loadAccounts,
	mergeAccountStorage,
	deduplicateAccountsByEmail,
	type AccountStorageV4,
} from "../src/storage.js";
import { sanitizeCrossModelPayloadInPlace } from "../src/transform/cross-model-sanitizer.js";
import {
	analyzeConversationState,
	needsThinkingRecovery,
	closeToolLoopForThinking,
	looksLikeCompactedThinkingTurn,
	hasPossibleCompactedThinking,
} from "../src/transform/thinking-recovery.js";
import { toGeminiSchema } from "../src/transform/gemini.js";
import {
	setAntigravityVersion,
	getAntigravityVersion,
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_FALLBACKS,
} from "../src/constants.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail, null, 2) : "");
	}
}

console.log("\n--- Math Formatting Tests ---");
{
	// Arrow conversions
	check("arrow \\to", latexToUnicode("x $\\to$ y") === "x → y");
	check("arrow \\Rightarrow", latexToUnicode("A $\\Rightarrow$ B") === "A ⇒ B");
	check("arrow \\iff", latexToUnicode("P $\\iff$ Q") === "P ⇔ Q");

	// Comparisons
	check("approx & neq", latexToUnicode("$\\pi \\approx 3.14$ and $x \\neq y$") === "π ≈ 3.14 and x ≠ y");
	check("leq & geq", latexToUnicode("$a \\le b$ and $c \\geq d$") === "a ≤ b and c ≥ d");

	// Greek letters
	check("greek alpha beta gamma", latexToUnicode("$\\alpha + \\beta = \\gamma$") === "α + β = γ");
	check("greek uppercase Delta", latexToUnicode("$\\Delta x$") === "Δ x");

	// Superscripts & Subscripts
	check("superscript", latexToUnicode("$x^2 + y^2 = z^2$") === "x² + y² = z²");
	check("subscript", latexToUnicode("$a_1 + a_2 = a_n$") === "a₁ + a₂ = aₙ");

	// Square roots & Fractions
	check("sqrt", latexToUnicode("$\\sqrt{x^2 + y^2}$") === "√(x² + y²)");
	check("cbrt", latexToUnicode("$\\sqrt[3]{8}$") === "∛(8)");
	check("frac", latexToUnicode("$\\frac{1}{2}$") === "1/2");

	// Complexity notation
	check("complexity O(n)", latexToUnicode("$\\mathcal{O}(n \\log n)$") === "O(n \\log n)");

	// Code block protection
	check("code block protected", latexToUnicode("```\n$foo$\\to$bar$\n```") === "```\n$foo$\\to$bar$\n```");
	check("inline code protected", latexToUnicode("Use `$VAR` here") === "Use `$VAR` here");

	// Currency dollar false positive handling
	check("currency not transformed", latexToUnicode("The cost is $10 and $20.") === "The cost is $10 and $20.");

	// MathStreamBuffer chunked streaming
	const buffer = new MathStreamBuffer();
	const part1 = buffer.process("The equation is $x \\");
	check("stream buffer holds unclosed math", part1 === "The equation is ");
	const part2 = buffer.process("to y$ in conclusion.");
	check("stream buffer emits completed math", part2 === "x → y in conclusion.");
	check("stream buffer empty after completion", !buffer.hasPending());
}

console.log("\n--- Model Resolver Tests ---");
{
	// Gemini 3.8 Flash
	const g38 = resolveBackendModel("gemini-3.8-flash", "high");
	check("gemini-3.8-flash high", g38.model === "gemini-3.8-flash-tiered" && g38.thinkingLevel === "high");
	const g38Min = resolveBackendModel("gemini-3.8-flash", "minimal");
	check("gemini-3.8-flash minimal mapped to low", g38Min.model === "gemini-3.8-flash-tiered" && g38Min.thinkingLevel === "low");

	// Gemini 3.7 Flash
	const g37 = resolveBackendModel("gemini-3.7-flash", "medium");
	check("gemini-3.7-flash medium", g37.model === "gemini-3.7-flash-tiered" && g37.thinkingLevel === "medium");

	// Gemini 3.6 Flash
	const g36Low = resolveBackendModel("gemini-3.6-flash", "low");
	check("gemini-3.6-flash low", g36Low.model === "gemini-3.6-flash-low");
	const g36Med = resolveBackendModel("gemini-3.6-flash", "medium");
	check("gemini-3.6-flash medium", g36Med.model === "gemini-3.6-flash-medium");
	const g36High = resolveBackendModel("gemini-3.6-flash", "high");
	check("gemini-3.6-flash high", g36High.model === "gemini-3.6-flash-high");

	// Gemini 3.5 Flash
	const g35Low = resolveBackendModel("gemini-3.5-flash", "low");
	check("gemini-3.5-flash low", g35Low.model === "gemini-3.5-flash-low");
	const g35High = resolveBackendModel("gemini-3.5-flash", "high");
	check("gemini 3.5 flash high agent", g35High.model === "gemini-3-flash-agent");

	// Gemini 3.1 Pro
	const g31Low = resolveBackendModel("gemini-3.1-pro", "low");
	check("gemini-3.1-pro low", g31Low.model === "gemini-3.1-pro-low");
	const g31High = resolveBackendModel("gemini-3.1-pro", "high");
	check("gemini-3.1-pro high", g31High.model === "gemini-pro-agent");

	// Claude Models
	const opusHigh = resolveBackendModel("claude-opus-4-6-thinking", "high");
	check("claude opus high budget 32768", opusHigh.thinkingBudget === 32768);
	const sonnet = resolveBackendModel("claude-sonnet-4-6");
	check("claude sonnet no budget", sonnet.thinkingBudget === undefined);

	// Image Model
	const img = resolveBackendModel("gemini-3.1-flash-image");
	check("image model resolved", img.model === "gemini-3.1-flash-image" && img.isImageModel === true);

	// Helper queries
	check("isClaudeModel true", isClaudeModel("claude-opus-4-6-thinking"));
	check("isClaudeModel false", !isClaudeModel("gemini-3.8-flash"));
	check("isClaudeThinkingModel true", isClaudeThinkingModel("claude-opus-4-6-thinking"));
	check("isClaudeThinkingModel false", !isClaudeThinkingModel("claude-sonnet-4-6"));
	check("isImageGenerationModel true", isImageGenerationModel("gemini-3.1-flash-image"));
	check("getModelFamily claude", getModelFamily("claude-opus-4-6-thinking") === "claude");
	check("getModelFamily flash", getModelFamily("gemini-3.8-flash") === "gemini-flash");
	check("getModelFamily pro", getModelFamily("gemini-3.1-pro") === "gemini-pro");
}

console.log("\n--- Device Fingerprint Tests ---");
{
	const fp = generateFingerprint();
	check("fingerprint deviceId", typeof fp.deviceId === "string" && fp.deviceId.length > 0);
	check("fingerprint userAgent format", fp.userAgent.startsWith("antigravity/"));
	check("fingerprint clientMetadata IDE", fp.clientMetadata.ideType === "ANTIGRAVITY");
	check("fingerprint platform WINDOWS or MACOS", fp.clientMetadata.platform === "WINDOWS" || fp.clientMetadata.platform === "MACOS");

	const headers = buildFingerprintHeaders(fp);
	check("buildFingerprintHeaders has User-Agent", typeof headers["User-Agent"] === "string" && headers["User-Agent"] === fp.userAgent);

	setAntigravityVersion("1.25.0");
	const changed = updateFingerprintVersion(fp);
	check("updateFingerprintVersion updates UA", changed && fp.userAgent.includes("1.25.0"));
}

console.log("\n--- Health Score & Token Bucket Rotation Tests ---");
{
	const health = new HealthScoreTracker({ initial: 70, successReward: 5, rateLimitPenalty: -15 });
	check("initial health score", health.getScore(0) === 70);
	health.recordSuccess(0);
	check("health reward on success", health.getScore(0) === 75);
	health.recordRateLimit(0);
	check("health penalty on rate limit", health.getScore(0) === 60);
	check("health isUsable", health.isUsable(0));

	const tokens = new TokenBucketTracker({ initialTokens: 10, maxTokens: 10 });
	check("token bucket has tokens", tokens.hasTokens(0, 5));
	check("token bucket consume", tokens.consume(0, 5));
	check("token bucket balance after consume", tokens.getTokens(0) === 5);
	tokens.refund(0, 2);
	check("token bucket balance after refund", Math.round(tokens.getTokens(0)) === 7);

	const accounts = [
		{ index: 0, lastUsed: Date.now() - 5000, healthScore: 90, isRateLimited: false, isCoolingDown: false },
		{ index: 1, lastUsed: Date.now() - 60000, healthScore: 85, isRateLimited: false, isCoolingDown: false },
	];
	const selected = selectHybridAccount(accounts, tokens, 0);
	check("hybrid selection returns valid account index", selected === 0 || selected === 1);
}

console.log("\n--- Storage V4 & AccountManager Tests ---");
{
	const tempDir = mkdtempSync(join(tmpdir(), "pi-antigravity-storage-test-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;

	// Write mock legacy accounts
	const legacyAccounts: AccountStorageV4 = {
		version: 4,
		activeIndex: 0,
		accounts: [
			{
				email: "acc1@gmail.com",
				refreshToken: "tok1",
				projectId: "proj1",
				addedAt: Date.now(),
				lastUsed: Date.now(),
				enabled: true,
				rateLimitResetTimes: {},
			},
			{
				email: "acc2@gmail.com",
				refreshToken: "tok2",
				projectId: "proj2",
				addedAt: Date.now(),
				lastUsed: Date.now(),
				enabled: true,
				rateLimitResetTimes: {},
			},
		],
	};
	await saveAccounts(legacyAccounts);

	const loaded = await loadAccounts();
	check("storage V4 load accounts length", loaded.accounts.length === 2);
	check("storage V4 account email", loaded.accounts[0]?.email === "acc1@gmail.com");

	const manager = new AccountManager();
	await manager.load();
	check("account manager loaded accounts", manager.getAccounts().length === 2);

	const acc = manager.selectAccount("gemini-3.8-flash");
	check("account manager selectAccount returns account", acc !== null && (acc.email === "acc1@gmail.com" || acc.email === "acc2@gmail.com"));

	if (acc) {
		manager.recordRateLimit(acc, "gemini", "QUOTA_EXHAUSTED", 429, 3000);
		check("account marked rate limited", manager.isAccountRateLimited(acc, "gemini-antigravity"));
	}

	// Test deduplicateAccountsByEmail
	const dupes = [
		{ email: "dup@gmail.com", refreshToken: "tokOld", lastUsed: 100, addedAt: 100 },
		{ email: "dup@gmail.com", refreshToken: "tokNew", lastUsed: 200, addedAt: 100 },
		{ email: "other@gmail.com", refreshToken: "tokOther", lastUsed: 150, addedAt: 150 },
	];
	const deduped = deduplicateAccountsByEmail(dupes);
	check("deduplicate accounts keeps newest", deduped.length === 2 && deduped[0]?.refreshToken === "tokNew");

	// Test saveAccountsReplace
	await saveAccountsReplace({
		version: 4,
		activeIndex: 0,
		accounts: [
			{
				email: "single@gmail.com",
				refreshToken: "tokSingle",
				addedAt: Date.now(),
				lastUsed: Date.now(),
				enabled: true,
				rateLimitResetTimes: {},
			},
		],
	});
	const reloaded = await loadAccounts();
	check("saveAccountsReplace writes exact list", reloaded.accounts.length === 1 && reloaded.accounts[0]?.email === "single@gmail.com");

	rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n--- Thinking Recovery Tests ---");
{
	const contents = [
		{ role: "user", parts: [{ text: "Hello" }] },
		{ role: "model", parts: [{ text: "Thinking...", thought: true }, { text: "I will call tool", functionCall: { name: "tool1", args: {} } }] },
		{ role: "user", parts: [{ functionResponse: { name: "tool1", response: { output: "done" } } }] },
	];

	const state = analyzeConversationState(contents);
	check("conversation in tool loop", state.inToolLoop === true);
	check("conversation turn has thinking", state.turnHasThinking === true);
	check("needsThinkingRecovery is false when thinking present", !needsThinkingRecovery(state));

	const corruptedContents = [
		{ role: "user", parts: [{ text: "Hello" }] },
		{ role: "model", parts: [{ functionCall: { name: "tool1", args: {} } }] },
		{ role: "user", parts: [{ functionResponse: { name: "tool1", response: { output: "done" } } }] },
	];
	const corruptedState = analyzeConversationState(corruptedContents);
	check("corrupted tool loop detected", corruptedState.inToolLoop === true && corruptedState.turnHasThinking === false);
	check("needsThinkingRecovery is true for corrupted loop", needsThinkingRecovery(corruptedState));

	const recovered = closeToolLoopForThinking(corruptedContents);
	check("closeToolLoopForThinking appends synthetic turns", recovered.length === 5);
	check("last recovered message is user [Continue]", (recovered[4] as { role: string; parts: Array<{ text: string }> }).parts[0]?.text === "[Continue]");

	check("looksLikeCompactedThinkingTurn true for bare tool call", looksLikeCompactedThinkingTurn(corruptedContents[1]));
	check("hasPossibleCompactedThinking detects compacted turn", hasPossibleCompactedThinking(corruptedContents, 1));
}

console.log("\n--- Daily Sandbox Quota Endpoint Order Tests ---");
{
	check("daily sandbox endpoint is first fallback", ANTIGRAVITY_ENDPOINT_FALLBACKS[0] === ANTIGRAVITY_ENDPOINT_DAILY);
}

console.log("\n--- Cross-Model Metadata Sanitization Tests ---");
{
	const payload = {
		contents: [
			{
				role: "model",
				parts: [
					{ thought: true, text: "Gemini thought", thoughtSignature: "c2lnbmF0dXJl" },
					{ text: "Response", signature: "claude-long-signature-0123456789012345678901234567890123456789" },
				],
			},
		],
	};

	const stripped = sanitizeCrossModelPayloadInPlace(payload, "claude-opus-4-6-thinking");
	check("cross model sanitization stripped signatures", stripped >= 1);
	const parts = payload.contents[0]!.parts as Array<{ thoughtSignature?: string }>;
	check("gemini signature removed for claude target", parts[0]?.thoughtSignature === undefined);
}

console.log("\n--- Gemini Schema Cleaning Tests ---");
{
	const schema = {
		type: "object",
		properties: {
			count: { type: "integer", default: 10, minimum: 1 },
			items: { type: "array" },
			metadata: { type: "object", properties: {} },
		},
		required: ["count", "missingProperty"],
		additionalProperties: false,
		$schema: "http://json-schema.org/draft-07/schema#",
	};

	const cleaned = toGeminiSchema(schema) as Record<string, unknown>;
	check("schema type uppercase", cleaned.type === "OBJECT");
	check("schema $schema stripped", !("$schema" in cleaned));
	check("schema additionalProperties stripped", !("additionalProperties" in cleaned));
	check("schema required filtered to existing props", Array.isArray(cleaned.required) && cleaned.required.length === 1 && cleaned.required[0] === "count");
	const props = cleaned.properties as Record<string, Record<string, unknown>>;
	check("schema array items fallback inserted", props.items?.items !== undefined && (props.items.items as { type: string }).type === "STRING");
	check("schema empty object placeholder inserted", (props.metadata?.properties as Record<string, unknown>)?._placeholder !== undefined);
}

console.log(failures === 0 ? "\nAll comprehensive tests passed successfully!" : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

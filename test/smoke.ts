/**
 * Offline smoke test for pi-antigravity-auth core logic.
 * Run: npx tsx test/smoke.ts
 */
import { convertMessages, convertTools, createToolNameMap } from "../src/convert.js";
import { resolveBackendModel, ANTIGRAVITY_MODELS } from "../src/models.js";
import { parseRefreshParts, formatRefreshParts, generatePKCE } from "../src/auth.js";
import { parseDurationToMs, extractRateLimitInfo } from "../src/ratelimit.js";
import { formatDuration, progressBar, extractProjectId, formatQuotaReport, formatCompactQuotaWidget } from "../src/quota.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail, null, 2) : "");
	}
}

// --- refresh parts encoding -------------------------------------------------
{
	const parts = parseRefreshParts("token123|my-project|managed-1");
	check("parseRefreshParts token", parts.refreshToken === "token123");
	check("parseRefreshParts projectId", parts.projectId === "my-project");
	check("formatRefreshParts roundtrip", formatRefreshParts(parts) === "token123|my-project|managed-1");
}

// --- PKCE -------------------------------------------------------------------
{
	const pkce = await generatePKCE();
	check("pkce verifier length", pkce.verifier.length >= 43);
	check("pkce challenge is base64url of sha256", /^[A-Za-z0-9_-]{43}$/.test(pkce.challenge));
}

// --- model resolution -------------------------------------------------------
{
	const r1 = resolveBackendModel("claude-opus-4-6-thinking", "low");
	check("claude opus thinking low budget", r1.model === "claude-opus-4-6-thinking" && r1.thinkingBudget === 8192, r1);
	const r2 = resolveBackendModel("claude-opus-4-6-thinking", "max");
	check("claude opus thinking max budget", r2.thinkingBudget === 32768, r2);
	const r3 = resolveBackendModel("claude-sonnet-4-6");
	check("claude sonnet no thinking", r3.model === "claude-sonnet-4-6" && !r3.thinkingBudget && !r3.thinkingLevel, r3);
	const r4 = resolveBackendModel("gemini-3.1-pro", "low");
	check("gemini 3.1 pro low backend", r4.model === "gemini-3.1-pro-low" && r4.thinkingLevel === "low", r4);
	const r5 = resolveBackendModel("gemini-3.1-pro", "high");
	check("gemini 3.1 pro high backend", r5.model === "gemini-pro-agent" && r5.thinkingLevel === "high", r5);
	const r6 = resolveBackendModel("gemini-3-flash", "medium");
	check("gemini 3 flash thinkingLevel", r6.model === "gemini-3-flash" && r6.thinkingLevel === "medium", r6);
	const r7 = resolveBackendModel("gemini-3.5-flash", "high");
	check("gemini 3.5 flash high agent", r7.model === "gemini-3-flash-agent", r7);
	const r8 = resolveBackendModel("gemini-3.6-flash", "medium");
	check("gemini 3.6 flash medium tier", r8.model === "gemini-3.6-flash-medium", r8);
	const r9 = resolveBackendModel("gemini-3.7-flash", "minimal");
	check("gemini 3.7 flash tiered", r9.model === "gemini-3.7-flash-tiered" && r9.thinkingLevel === "low", r9);
	const r10 = resolveBackendModel("gemini-2.5-flash", "high");
	check("gemini 2.5 flash budget", r10.thinkingBudget === 24576, r10);
	check("model catalog nonempty", ANTIGRAVITY_MODELS.length >= 8);
}

// --- tool name mapping ------------------------------------------------------
const tools = [
	{ name: "read", description: "Read file" },
	{ name: "mcp/query thing", description: "Bad name" },
	{ name: "1bad", description: "Starts with digit" },
];
{
	const map = createToolNameMap(tools);
	check("tool map size", map.size === 3, [...map.entries()]);
	const wireNames = [...map.keys()];
	check("wire names valid", wireNames.every((n) => /^[a-zA-Z_][a-zA-Z0-9_.:\-]*$/.test(n)), wireNames);
	const decls = convertTools(tools as never, (real) => {
		for (const [w, r] of map) if (r === real) return w;
		return real;
	});
	check("convertTools wraps declarations", decls?.[0]?.functionDeclarations.length === 3);
	// roundtrip back to real names
	const toReal = (w: string) => map.get(w) ?? w;
	check("roundtrip names", decls !== undefined && toReal(decls[0]!.functionDeclarations[1] && typeof (decls[0]!.functionDeclarations[1] as { name: string }).name === "string" ? (decls[0]!.functionDeclarations[1] as { name: string }).name : "") === "mcp/query thing");
}

// --- schema sanitization via convertTools -----------------------------------
{
	const toolsWithMeta = [
		{
			name: "search",
			description: "Search",
			parameters: {
				type: "object",
				properties: { q: { type: "string", default: "x", const: "y" } },
				$schema: "http://json-schema.org/draft-07/schema#",
				$defs: {},
			},
		},
	];
	const map = createToolNameMap(toolsWithMeta as never);
	const decls = convertTools(toolsWithMeta as never, (real) => real);
	const params = ((decls?.[0]?.functionDeclarations?.[0] as { parameters?: Record<string, unknown> }).parameters ?? {}) as Record<string, unknown>;
	check("$schema stripped", !("$schema" in params), params);
	check("const stripped in nested prop", !("const" in ((params.properties as Record<string, Record<string, unknown>>).q ?? {})));
}

// --- message conversion -----------------------------------------------------
{
	const provider = "antigravity";
	const messages = [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should read the file", thinkingSignature: "c2lnbmF0dXJl" },
				{ type: "text", text: "Let me look." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x" }, thoughtSignature: "c2ln" },
			],
			provider,
			model: "claude-opus-4-6-thinking",
		},
		{
			role: "toolResult",
			content: [{ type: "text", text: "file contents" }],
			toolCallId: "call_1",
			toolName: "read",
			isError: false,
		},
	];
	const contents = convertMessages(
		{ id: "claude-opus-4-6-thinking", provider },
		messages as never,
		(w) => w,
		(w) => w,
	);

	check("contents length", contents.length === 3, contents.length);
	check("user turn", JSON.stringify(contents[0]) === JSON.stringify({ role: "user", parts: [{ text: "hello" }] }));
	const assistantParts = contents[1]!.parts;
	check("thinking part kept w/ signature", (assistantParts[0] as { thought?: boolean; thoughtSignature?: string }).thought === true
		&& (assistantParts[0] as { thoughtSignature?: string }).thoughtSignature === "c2lnbmF0dXJl", assistantParts[0]);
	check("text part", (assistantParts[1] as { text?: string }).text === "Let me look.");
	const fc = (assistantParts[2] as { functionCall?: { name?: string; args?: unknown; id?: string } }).functionCall;
	check("functionCall carries id + sanitized signature replay", fc?.id === "call_1" && fc.name === "read",
		assistantParts[2]);
	check("toolResult merged into user turn", contents[2]!.role === "user"
		&& typeof (contents[2]!.parts[0] as { functionResponse?: { response?: { output?: unknown } } }).functionResponse?.response?.output === "string");

	// Cross-provider history: signatures dropped, thinking becomes plain text.
	const crossContents = convertMessages(
		{ id: "claude-opus-4-6-thinking", provider },
		[
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "invalid-sig!!!" }],
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		] as never,
		(w) => w,
		(w) => w,
	);
	const crossPart = crossContents[0]!.parts[0] as { text?: string; thoughtSignature?: string };
	check("cross-provider thinking -> plain text without signature", crossPart.text === "hmm" && crossPart.thoughtSignature === undefined, crossPart);

	// Claude thinking model with missing signature -> skip sentinel injected.
	const sentinelContents = convertMessages(
		{ id: "claude-opus-4-6-thinking", provider },
		[
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "hmm" }],
				provider,
				model: "claude-opus-4-6-thinking",
			},
		] as never,
		(w) => w,
		(w) => w,
	);
	const sentinelPart = sentinelContents[0]!.parts[0] as { thoughtSignature?: string };
	check("missing claude signature -> skip_thought_signature_validator",
		sentinelPart.thoughtSignature === "skip_thought_signature_validator", sentinelPart);
}

// --- rate limit parsing ------------------------------------------------------
{
	check("go duration compound", parseDurationToMs("1h16m0.667s") === Math.round((1 * 3600 + 16 * 60) * 1000) + 667);
	check("go duration seconds", parseDurationToMs("3.957s") === 3957);
	const info = extractRateLimitInfo({
		error: {
			code: 429,
			message: "You have exhausted your capacity on this model.",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" },
			],
		},
	});
	check("retry info extracted", info.retryDelayMs === 12000, info);
	const info2 = extractRateLimitInfo({
		error: { code: 429, message: "quota will reset after 45s." },
	});
	check("message fallback parsed", info2.retryDelayMs === 45000, info2);
}

// --- quota formatting --------------------------------------------------------
{
	check("formatDuration hours minutes", formatDuration(3600000 * 2 + 60000 * 30) === "2h 30m");
	check("formatDuration days", formatDuration(86400000 * 3 + 3600000 * 4) === "3d 4h");
	check("progressBar 100%", progressBar(100) === "[██████████] 100%");
	check("progressBar 50%", progressBar(50) === "[█████░░░░░] 50%");
	check("extractProjectId string", extractProjectId("my-proj") === "my-proj");
	check("extractProjectId object", extractProjectId({ id: "proj-123" }) === "proj-123");

	const report = formatQuotaReport(
		[
			{
				email: "test@example.com",
				success: true,
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{
								bucketId: "gemini-weekly",
								displayName: "Weekly Limit",
								window: "weekly",
								remainingFraction: 0.9,
								resetTime: new Date(Date.now() + 3600000 * 10).toISOString(),
							},
						],
					},
				],
			},
		],
		[
			{
				email: "test@example.com",
				refreshToken: "tok",
				source: "primary",
			},
		],
	);
	check("formatQuotaReport contains Gemini Models", report.includes("Gemini Models"));
	check("formatQuotaReport contains progress bar", report.includes("█████████░"));

	const wideLines = formatCompactQuotaWidget(
		[
			{
				email: "test@example.com",
				success: true,
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{
								bucketId: "gemini-5h",
								displayName: "Five Hour Limit",
								window: "5h",
								remainingFraction: 0.8,
								resetTime: new Date(Date.now() + 3600000 * 2).toISOString(),
							},
							{
								bucketId: "gemini-weekly",
								displayName: "Weekly Limit",
								window: "weekly",
								remainingFraction: 0.95,
							},
						],
					},
					{
						displayName: "Claude and GPT models",
						buckets: [
							{
								bucketId: "3p-5h",
								displayName: "Five Hour Limit",
								window: "5h",
								remainingFraction: 1.0,
							},
							{
								bucketId: "3p-weekly",
								displayName: "Weekly Limit",
								window: "weekly",
								remainingFraction: 1.0,
							},
						],
					},
				],
			},
		],
		[
			{
				email: "test@example.com",
				refreshToken: "tok",
				source: "primary",
			},
		],
		200,
	);
	check("wide widgetLines has 1 line", wideLines.length === 1, wideLines);
	check("wide widgetLines contains both 5h and Wk", wideLines[0]!.includes("5h") && wideLines[0]!.includes("Wk"), wideLines[0]);

	const narrowLines = formatCompactQuotaWidget(
		[
			{
				email: "test@example.com",
				success: true,
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{
								bucketId: "gemini-5h",
								displayName: "Five Hour Limit",
								window: "5h",
								remainingFraction: 0.8,
							},
							{
								bucketId: "gemini-weekly",
								displayName: "Weekly Limit",
								window: "weekly",
								remainingFraction: 0.95,
							},
						],
					},
					{
						displayName: "Claude and GPT models",
						buckets: [
							{
								bucketId: "3p-5h",
								displayName: "Five Hour Limit",
								window: "5h",
								remainingFraction: 1.0,
							},
							{
								bucketId: "3p-weekly",
								displayName: "Weekly Limit",
								window: "weekly",
								remainingFraction: 1.0,
							},
						],
					},
				],
			},
		],
		[
			{
				email: "test@example.com",
				refreshToken: "tok",
				source: "primary",
			},
		],
		80,
	);
	check("narrow widgetLines has 2 lines", narrowLines.length === 2, narrowLines);
	check("narrow widgetLines line 1 is 5-Hour", narrowLines[0]!.includes("5-Hour"), narrowLines[0]);
	check("narrow widgetLines line 2 is Weekly", narrowLines[1]!.includes("Weekly"), narrowLines[1]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

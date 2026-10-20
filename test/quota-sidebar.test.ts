import test from "node:test";
import assert from "node:assert/strict";
import {
	renderQuotaSidebarPanel,
	isSidebarTuiAvailable,
	registerQuotaSidebarPanelWithTui,
	notifySidebarRender,
	_setCachedQuotaForTesting,
	fetchUserQuotaSummary,
	fetchLiveModelQuotas,
	getLocalLanguageServerInfo,
	fetchLocalLanguageServerQuota,
} from "../src/quota.js";

test("isSidebarTuiAvailable returns boolean", () => {
	const available = isSidebarTuiAvailable();
	assert.equal(typeof available, "boolean");
});

test("registerQuotaSidebarPanelWithTui registers into global panels", () => {
	const g = globalThis as any;
	registerQuotaSidebarPanelWithTui();

	if (g.__PI_SIDEBAR_TUI__?.registerPanel) {
		assert.ok(true);
	} else {
		assert.ok(g.__PI_SIDEBAR_PANELS__ instanceof Map);
		const panel = g.__PI_SIDEBAR_PANELS__.get("antigravity-quota");
		assert.ok(panel, "Panel should be registered");
		assert.equal(panel.id, "antigravity-quota");
		assert.equal(panel.order, 20);
	}
});

test("renderQuotaSidebarPanel renders beautiful header and respects width", () => {
	const lines = renderQuotaSidebarPanel(40);
	assert.ok(lines.length >= 2, "Should have header and separator");
	assert.ok(lines[0]!.includes("Quota"), "Header should contain 'Quota'");

	// Check separator width
	assert.ok(lines[1]!.includes("───"), "Separator should contain line characters");

	// Test with various widths
	const narrowLines = renderQuotaSidebarPanel(30);
	assert.ok(narrowLines[0]!.includes("Quota"));

	const wideLines = renderQuotaSidebarPanel(60);
	assert.ok(wideLines[0]!.includes("Quota"));

	// Ensure faint/thin ANSI code (\x1b[2m) is never used, which causes thin/spindly fonts in terminals
	for (const line of lines) {
		assert.ok(!line.includes("\x1b[2m"), "Line should not contain \\x1b[2m (faint font weight)");
	}
});

test("notifySidebarRender safely executes without error", () => {
	assert.doesNotThrow(() => {
		notifySidebarRender();
	});
});

test("progress bars end at the exact same spots across Gemini and Claude", () => {
	const mockAccounts = [
		{
			email: "user@example.com",
			refreshToken: "tok",
			enabled: true,
			index: 0,
		},
	];

	const mockResults = [
		{
			email: "user@example.com",
			success: true,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{
							bucketId: "gemini-5h",
							displayName: "Five Hour Limit",
							window: "5h",
							remainingFraction: 0.55,
							resetTime: new Date(Date.now() + 3600000 * 2 + 60000 * 22).toISOString(),
						},
						{
							bucketId: "gemini-weekly",
							displayName: "Weekly Limit",
							window: "weekly",
							remainingFraction: 0.5,
							resetTime: new Date(Date.now() + 3600000 * 22 + 60000 * 34).toISOString(),
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
	];

	_setCachedQuotaForTesting(mockResults as any, mockAccounts as any);

	const widthsToTest = [35, 37, 40, 45, 50];
	for (const width of widthsToTest) {
		const lines = renderQuotaSidebarPanel(width);
		const barLengths: number[] = [];
		const barEndPositions: number[] = [];

		for (const rawLine of lines) {
			const plain = rawLine.replace(/\x1b\[[0-9;]*m/g, "");
			const match = plain.match(/^ {3}(5h|Wk) {2}([█░]+)/);
			if (match && match[2]) {
				const bar = match[2];
				barLengths.push(bar.length);
				// The position in the string where the progress bar ends
				const endPos = (plain.indexOf(bar)) + bar.length;
				barEndPositions.push(endPos);
			}
		}

		assert.equal(barLengths.length, 4, `Expected 4 quota bar lines for width ${width}`);

		// Assert that ALL 4 bars have the EXACT SAME length
		for (let i = 1; i < barLengths.length; i++) {
			assert.equal(
				barLengths[i],
				barLengths[0],
				`Bar ${i} length (${barLengths[i]}) differs from Bar 0 (${barLengths[0]}) at width ${width}`,
			);
		}

		// Assert that ALL 4 bars end at the EXACT SAME column position
		for (let i = 1; i < barEndPositions.length; i++) {
			assert.equal(
				barEndPositions[i],
				barEndPositions[0],
				`Bar ${i} end position (${barEndPositions[i]}) differs from Bar 0 (${barEndPositions[0]}) at width ${width}`,
			);
		}
	}
});

test("fetchUserQuotaSummary merges groups across endpoints and queries prod first", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: any) => {
		calls.push(String(url));
		if (String(url).includes("daily-cloudcode-pa.googleapis.com")) {
			return new Response(
				JSON.stringify({
					groups: [
						{
							displayName: "Claude and GPT models",
							buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0.99 }],
						},
					],
				}),
				{ status: 200 },
			);
		}
		if (String(url).includes("cloudcode-pa.googleapis.com")) {
			return new Response(
				JSON.stringify({
					groups: [
						{
							displayName: "Gemini Models",
							buckets: [{ bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0.7 }],
						},
					],
				}),
				{ status: 200 },
			);
		}
		return new Response("Not found", { status: 404 });
	}) as typeof fetch;

	try {
		const res = await fetchUserQuotaSummary("fake-token");
		assert.equal(calls.length, 2);
		assert.ok(calls[0]!.includes("daily-cloudcode-pa.googleapis.com"));
		assert.ok(calls[1]!.includes("cloudcode-pa.googleapis.com"));
		assert.equal(res.groups?.length, 2);
		assert.ok(res.groups?.some((g) => g.displayName === "Gemini Models"));
		assert.ok(res.groups?.some((g) => g.displayName === "Claude and GPT models"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchLiveModelQuotas parses model-level quotaInfo from fetchAvailableModels", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: any) => {
		return new Response(
			JSON.stringify({
				models: {
					"gemini-3.8-flash-tiered": {
						quotaInfo: { remainingFraction: 0.85, resetTime: "2026-10-16T05:22:45Z" },
					},
					"claude-sonnet-5-5-high": {
						quotaInfo: { remainingFraction: 1.0, resetTime: "2026-10-16T05:26:33Z" },
					},
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	try {
		const res = await fetchLiveModelQuotas("fake-token");
		assert.equal(res.gemini?.remainingFraction, 0.85);
		assert.equal(res.claude?.remainingFraction, 1.0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchUserQuotaSummary returns immediately when prod has both Gemini and Claude", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: any) => {
		calls.push(String(url));
		return new Response(
			JSON.stringify({
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [{ bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0.7 }],
					},
					{
						displayName: "Claude and GPT models",
						buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0.99 }],
					},
				],
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	try {
		const res = await fetchUserQuotaSummary("fake-token");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.includes("cloudcode-pa.googleapis.com"));
		assert.equal(res.groups?.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchLocalLanguageServerQuota handles invalid server info gracefully", async () => {
	const res = await fetchLocalLanguageServerQuota({ port: 1, csrfToken: "invalid" });
	assert.equal(res, null);
});

test("getLocalLanguageServerInfo returns null or valid port object", () => {
	const info = getLocalLanguageServerInfo();
	if (info) {
		assert.equal(typeof info.port, "number");
		assert.equal(typeof info.csrfToken, "string");
	} else {
		assert.equal(info, null);
	}
});

test("renderQuotaSidebarPanel renders separate Gemini 4 Argon quota", () => {
	const mockAccounts = [{ email: "test@example.com" }];
	const mockResults = [
		{
			email: "test@example.com",
			success: true,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ bucketId: "gemini-5h", displayName: "Five Hour Limit", remainingFraction: 0.9 },
						{ bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0.8 },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{ bucketId: "3p-5h", displayName: "Five Hour Limit", remainingFraction: 1.0 },
						{ bucketId: "3p-weekly", displayName: "Weekly Limit", remainingFraction: 0.95 },
					],
				},
				{
					displayName: "Gemini 4 Argon",
					buckets: [
						{ bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", remainingFraction: 0.98 },
					],
				},
			],
		},
	];

	_setCachedQuotaForTesting(mockResults as any, mockAccounts as any);
	const lines = renderQuotaSidebarPanel(40);
	const text = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	assert.ok(text.includes("Gemini 4 Argon"), "Expected Gemini 4 Argon section in sidebar");
	assert.ok(text.includes("98%"), "Expected 98% bar for Argon");
});

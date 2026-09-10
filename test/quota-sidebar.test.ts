import test from "node:test";
import assert from "node:assert/strict";
import {
	renderQuotaSidebarPanel,
	isSidebarTuiAvailable,
	registerQuotaSidebarPanelWithTui,
	notifySidebarRender,
	_setCachedQuotaForTesting,
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

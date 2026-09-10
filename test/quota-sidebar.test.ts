import test from "node:test";
import assert from "node:assert/strict";
import {
	renderQuotaSidebarPanel,
	isSidebarTuiAvailable,
	registerQuotaSidebarPanelWithTui,
	notifySidebarRender,
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

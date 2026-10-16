#!/usr/bin/env npx tsx
/**
 * Cross-Model Sanitization E2E Test.
 * Verifies thought signatures and metadata are cleanly sanitized when
 * switching between Gemini and Claude models.
 * Zero secrets stored in file.
 *
 * Usage:
 *   npx tsx scripts/test-cross-model.ts
 */
import { sanitizeCrossModelPayloadInPlace } from "../src/transform/cross-model-sanitizer.js";
import { getModelFamily } from "../src/model-resolver.js";

const GEMINI_THOUGHT_SIGNATURE = "EsgQCsUQAXLI2nybuafAE150LGTo2r78fakesig123abc456def789";

function createGeminiHistory() {
	return {
		contents: [
			{
				role: "user",
				parts: [{ text: "Check disk space. Think about which filesystems are most utilized." }],
			},
			{
				role: "model",
				parts: [
					{
						thought: true,
						text: "Let me analyze the disk usage by running df -h to see filesystem utilization...",
						thoughtSignature: GEMINI_THOUGHT_SIGNATURE,
					},
					{
						functionCall: {
							name: "Bash",
							args: { command: "df -h", description: "Check disk space" },
						},
						metadata: {
							google: {
								thoughtSignature: GEMINI_THOUGHT_SIGNATURE,
							},
						},
					},
				],
			},
			{
				role: "function",
				parts: [
					{
						functionResponse: {
							name: "Bash",
							response: {
								output: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       100G   62G   38G  62% /",
							},
						},
					},
				],
			},
			{
				role: "model",
				parts: [{ text: "The root filesystem is 62% utilized, which is moderate usage." }],
			},
		],
	};
}

function runTests(): void {
	console.log("=== Cross-Model Sanitization E2E Test ===\n");

	let passed = 0;
	let failed = 0;

	console.log("Test 1: Model family detection");
	const geminiFamily = getModelFamily("gemini-3.8-flash");
	const claudeFamily = getModelFamily("claude-opus-5-5-high");
	if (geminiFamily === "gemini-flash" && claudeFamily === "claude") {
		console.log("  ✅ PASS: Model families detected correctly");
		passed++;
	} else {
		console.log(`  ❌ FAIL: Expected gemini-flash/claude, got ${geminiFamily}/${claudeFamily}`);
		failed++;
	}

	console.log("\nTest 2: Gemini → Claude sanitization");
	const payload = createGeminiHistory();
	sanitizeCrossModelPayloadInPlace(payload, "claude-sonnet-5-5-high");

	const modelParts = payload.contents[1]!.parts;
	const thinkingPart = modelParts[0] as any;
	const toolPart = modelParts[1] as any;

	if (thinkingPart.thoughtSignature === undefined) {
		console.log("  ✅ PASS: Top-level thoughtSignature stripped from thinking part");
		passed++;
	} else {
		console.log("  ❌ FAIL: thoughtSignature still present on thinking part");
		failed++;
	}

	if (toolPart.metadata?.google?.thoughtSignature === undefined) {
		console.log("  ✅ PASS: Nested metadata.google.thoughtSignature stripped from tool part");
		passed++;
	} else {
		console.log("  ❌ FAIL: metadata.google.thoughtSignature still present");
		failed++;
	}

	if (toolPart.functionCall?.name === "Bash") {
		console.log("  ✅ PASS: functionCall structure preserved");
		passed++;
	} else {
		console.log("  ❌ FAIL: functionCall corrupted");
		failed++;
	}

	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

runTests();

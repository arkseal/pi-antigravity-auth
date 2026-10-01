/**
 * Integration test: full streaming pipeline against a mocked Antigravity API.
 * Verifies envelope shape, SSE unwrapping, event emission, usage mapping,
 * and 429 -> account rotation -> retry.
 *
 * Run: npx tsx test/stream-mock.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Seed a fake pi environment ---------------------------------------------
const fakeAgentDir = mkdtempSync(join(tmpdir(), "pi-antigravity-test-"));
mkdirSync(fakeAgentDir, { recursive: true });
writeFileSync(
	join(fakeAgentDir, "auth.json"),
	JSON.stringify({
		antigravity: {
			type: "oauth",
			refresh: "test-refresh-token|test-project-id",
			access: "",
			expires: 0,
		},
	}),
);
process.env.PI_CODING_AGENT_DIR = fakeAgentDir;

const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let requestCount = 0;
let rateLimitedOnce = true; // first request gets a 429, second succeeds

const ssePayload = [
	{
		response: {
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							{ thought: true, text: "Thinking about it", thoughtSignature: "c2lnbmF0dXJl" },
							{ text: "Hello" },
						],
					},
				},
			],
			usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20 },
		},
	},
	{
		response: {
			candidates: [
				{
					content: {
						role: "model",
						parts: [{ text: " world" }],
					},
				},
			],
		},
	},
	{
		response: {
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							{
								functionCall: { name: "read", args: { path: "/tmp/x" }, id: "call_42" },
								thoughtSignature: "Y2FsbHNpZw==",
							},
						],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 100,
				candidatesTokenCount: 10,
				thoughtsTokenCount: 5,
				cachedContentTokenCount: 20,
				totalTokenCount: 115,
			},
		},
	},
];

const server: Server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		requestCount++;
		const body = raw ? JSON.parse(raw) : null;
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
		requests.push({ url: req.url ?? "", headers, body });

		if (rateLimitedOnce) {
			rateLimitedOnce = false;
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: 429,
						message: "You have exhausted your capacity on this model. Your quota will reset after 3s.",
						details: [
							{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.5s" },
						],
					},
				}),
			);
			return;
		}

		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const chunk of ssePayload) {
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		res.end();
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

// Redirect Antigravity endpoint traffic to the mock server.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
	if (url.includes("cloudcode-pa") || url.includes("v1internal")) {
		return realFetch(`http://127.0.0.1:${port}${url.replace(/^https?:\/\/[^/]+/, "")}`, init);
	}
	if (url.includes("oauth2.googleapis.com/token")) {
		return new Response(
			JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}
	throw new Error(`Unexpected fetch in test: ${url}`);
};

// Import after env + fetch patching.
const { streamAntigravity } = await import("../src/stream.js");
const { ANTIGRAVITY_API_ID } = await import("../src/stream.js");

const model = {
	id: "claude-opus-4-6-thinking",
	name: "Claude Opus 4.6 Thinking (Antigravity)",
	api: ANTIGRAVITY_API_ID,
	provider: "antigravity",
	baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
} as never;

const context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [
		{ role: "user", content: "hi there" },
	] as never,
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	],
} as never;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
	}
}

const events: any[] = [];
const stream = streamAntigravity(model, context, { reasoning: "low" });
for await (const event of stream) {
	events.push(event);
}

await new Promise((r) => setTimeout(r, 50));

check("two requests made (429 then success)", requestCount === 2, requestCount);
check("429 retry resent same model", (requests[0]?.body as any)?.model === (requests[1]?.body as any)?.model);

// Verify envelope of successful request
const okReq = requests[1];
check("envelope project id", (okReq?.body as any)?.project === "test-project-id");
check("envelope model passthrough for claude", (okReq?.body as any)?.model === "claude-opus-4-6-thinking");
check("envelope userAgent", (okReq?.body as any)?.userAgent === "antigravity");
const innerRequest = (okReq?.body as any)?.request;
check("systemInstruction wrapped in parts", innerRequest?.systemInstruction?.parts?.[0]?.text === "You are a helpful assistant.");
check("contents converted", Array.isArray(innerRequest?.contents) && innerRequest.contents[0]?.role === "user");
check("tools converted to functionDeclarations", innerRequest?.tools?.[0]?.functionDeclarations?.[0]?.name === "read");
check("thinkingBudget set from reasoning=low", innerRequest?.generationConfig?.thinkingConfig?.thinkingBudget === 8192, innerRequest?.generationConfig?.thinkingConfig);
check("bearer auth header", okReq?.headers?.authorization === "Bearer mock-access-token");
check("client metadata header present", typeof okReq?.headers?.["client-metadata"] === "string");

// Verify emitted events
check("start event", events.some((e) => e.type === "start"));
const thinkingStart = events.findIndex((e) => e.type === "thinking_start");
check("thinking_start before text_start", thinkingStart >= 0 && events.slice(thinkingStart).some((e) => e.type === "text_start"));
check("thinking deltas streamed", events.filter((e) => e.type === "thinking_delta").map((e) => e.delta).join("") === "Thinking about it");
check("text deltas streamed", events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("") === "Hello world");
const toolCallEnd = events.find((e) => e.type === "toolcall_end");
check("functionCall parsed to toolCall", toolCallEnd?.toolCall?.name === "read"
	&& toolCallEnd?.toolCall?.id === "call_42"
	&& toolCallEnd?.toolCall?.arguments?.path === "/tmp/x", toolCallEnd?.toolCall);
check("functionCall thoughtSignature kept", toolCallEnd?.toolCall?.thoughtSignature === "Y2FsbHNpZw==");
const done = events.find((e) => e.type === "done");
check("done is toolUse when functionCalls present", done?.reason === "toolUse", done?.reason);
check("usage mapped (input excludes cached)", done?.message?.usage?.input === 80, done?.message?.usage);
check("usage mapped (output includes thoughts)", done?.message?.usage?.output === 15);
check("cache read mapped", done?.message?.usage?.cacheRead === 20);
check("thinking signature retained", done?.message?.content?.[0]?.thinkingSignature === "c2lnbmF0dXJl");

// --- Test 2: Modern TranscriptContext (pi >= 0.86) without context.tools or context.systemPrompt
{
	const modernContext = {
		messages: [
			{
				role: "system",
				content: "You are an expert coder.",
				toolsAdded: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
					{
						name: "bash",
						description: "Run command",
						parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
					},
				],
			},
			{ role: "user", content: "list files" },
		],
	} as never;

	const modernEvents: any[] = [];
	const modernStream = streamAntigravity(model, modernContext, { reasoning: "low" });
	for await (const event of modernStream) {
		modernEvents.push(event);
	}

	const modernReq = requests[requests.length - 1];
	const modernInner = (modernReq?.body as any)?.request;
	check("modern: systemInstruction extracted from transcript",
		modernInner?.systemInstruction?.parts?.[0]?.text?.includes("You are an expert coder."));
	check("modern: tools extracted from transcript toolsAdded",
		modernInner?.tools?.[0]?.functionDeclarations?.length === 2 &&
		modernInner?.tools?.[0]?.functionDeclarations?.some((f: any) => f.name === "read") &&
		modernInner?.tools?.[0]?.functionDeclarations?.some((f: any) => f.name === "bash"));
	check("modern: contents only has user/model messages",
		Array.isArray(modernInner?.contents) && modernInner.contents.every((c: any) => c.role === "user" || c.role === "model"));
	check("modern: stream completed successfully",
		modernEvents.some((e) => e.type === "done"));
}

server.close();
console.log(failures === 0 ? "\nStream mock test passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

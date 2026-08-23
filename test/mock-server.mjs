/**
 * Mock Antigravity server (plain JS for easy process management).
 * Env:
 *   MOCK_ANTIGRAVITY_PORT  port to listen on (default 51999)
 *   MOCK_ANTIGRAVITY_OUT   file to write the last captured request to
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_ANTIGRAVITY_PORT ?? 51999);
const OUT_FILE = process.env.MOCK_ANTIGRAVITY_OUT ?? "/tmp/mock-antigravity-last-request.json";

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		if (req.url?.startsWith("/token")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }));
			return;
		}
		if (req.url?.includes("v1internal:streamGenerateContent")) {
			try {
				writeFileSync(OUT_FILE, JSON.stringify({ url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") }));
			} catch {}
			const chunks = [
				{ response: { candidates: [{ content: { role: "model", parts: [{ text: "Hello from mock Antigravity!" }] } }] } },
				{
					response: {
						candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 8, totalTokenCount: 50 },
					},
				},
			];
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.end();
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock antigravity listening on ${PORT}`));

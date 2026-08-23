/**
 * Test harness extension: redirects Antigravity/Google endpoints to a local
 * mock server so the full pi runtime can be exercised offline.
 */
const MOCK_PORT = process.env.MOCK_ANTIGRAVITY_PORT ?? "51999";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
	if (url.includes("v1internal") || url.includes("oauth2.googleapis.com/token")) {
		const rewritten = `http://127.0.0.1:${MOCK_PORT}${url.replace(/^https?:\/\/[^/]+/, "")}`;
		return realFetch(rewritten, init);
	}
	return realFetch(input as RequestInfo, init);
};

export default function () {}

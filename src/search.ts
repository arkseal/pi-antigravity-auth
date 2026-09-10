/**
 * Google Search Grounding Tool for Antigravity.
 * Ported from opencode-antigravity-auth-updated/src/plugin/search.ts
 */
import {
	ANTIGRAVITY_ENDPOINT,
	getAntigravityHeaders,
	SEARCH_MODEL,
	SEARCH_TIMEOUT_MS,
	SEARCH_SYSTEM_INSTRUCTION,
} from "./constants.js";
import { createLogger } from "./logger.js";

const log = createLogger("search");

interface GroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GroundingMetadata {
	webSearchQueries?: string[];
	groundingChunks?: GroundingChunk[];
}

interface UrlMetadata {
	retrieved_url?: string;
	url_retrieval_status?: string;
}

interface SearchResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
			role?: string;
		};
		finishReason?: string;
		groundingMetadata?: GroundingMetadata;
		urlContextMetadata?: { url_metadata?: UrlMetadata[] };
	}>;
	error?: { code?: number; message?: string; status?: string };
}

interface AntigravitySearchResponse {
	response?: SearchResponse;
	error?: { code?: number; message?: string; status?: string };
}

export interface SearchArgs {
	query: string;
	urls?: string[];
}

export interface SearchResult {
	text: string;
	sources: Array<{ title: string; url: string }>;
	searchQueries: string[];
	urlsRetrieved: Array<{ url: string; status: string }>;
}

let sessionCounter = 0;
const sessionPrefix = `search-${Date.now().toString(36)}`;

function generateRequestId(): string {
	return `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSessionId(): string {
	sessionCounter++;
	return `${sessionPrefix}-${sessionCounter}`;
}

function formatSearchResult(result: SearchResult): string {
	const lines: string[] = [];
	lines.push("## Search Results\n");
	lines.push(result.text);
	lines.push("");

	if (result.sources.length > 0) {
		lines.push("### Sources");
		for (const source of result.sources) {
			lines.push(`- [${source.title}](${source.url})`);
		}
		lines.push("");
	}

	if (result.urlsRetrieved.length > 0) {
		lines.push("### URLs Retrieved");
		for (const url of result.urlsRetrieved) {
			const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "✓" : "✗";
			lines.push(`- ${status} ${url.url}`);
		}
		lines.push("");
	}

	if (result.searchQueries.length > 0) {
		lines.push("### Search Queries Used");
		for (const q of result.searchQueries) {
			lines.push(`- "${q}"`);
		}
	}

	return lines.join("\n");
}

function parseSearchResponse(data: AntigravitySearchResponse): SearchResult {
	const result: SearchResult = {
		text: "",
		sources: [],
		searchQueries: [],
		urlsRetrieved: [],
	};

	const response = data.response;
	if (!response || !response.candidates || response.candidates.length === 0) {
		if (data.error) {
			result.text = `Error: ${data.error.message ?? "Unknown error"}`;
		} else if (response?.error) {
			result.text = `Error: ${response.error.message ?? "Unknown error"}`;
		}
		return result;
	}

	const candidate = response.candidates[0];
	if (!candidate) return result;

	if (candidate.content?.parts) {
		result.text = candidate.content.parts
			.map((p: { text?: string }) => p.text ?? "")
			.filter(Boolean)
			.join("\n");
	}

	if (candidate.groundingMetadata) {
		const groundingMeta = candidate.groundingMetadata;
		if (groundingMeta.webSearchQueries) {
			result.searchQueries = groundingMeta.webSearchQueries;
		}
		if (groundingMeta.groundingChunks) {
			for (const chunk of groundingMeta.groundingChunks) {
				if (chunk.web?.uri && chunk.web?.title) {
					result.sources.push({
						title: chunk.web.title,
						url: chunk.web.uri,
					});
				}
			}
		}
	}

	if (candidate.urlContextMetadata?.url_metadata) {
		for (const meta of candidate.urlContextMetadata.url_metadata) {
			if (meta.retrieved_url) {
				result.urlsRetrieved.push({
					url: meta.retrieved_url,
					status: meta.url_retrieval_status ?? "UNKNOWN",
				});
			}
		}
	}

	return result;
}

export async function executeSearch(
	args: SearchArgs,
	accessToken: string,
	projectId: string,
	abortSignal?: AbortSignal,
): Promise<string> {
	const { query, urls } = args;

	let prompt = query;
	if (urls && urls.length > 0) {
		prompt = `${query}\n\nURLs to analyze:\n${urls.join("\n")}`;
	}

	const tools: Array<Record<string, unknown>> = [{ googleSearch: {} }];
	if (urls && urls.length > 0) {
		tools.push({ urlContext: {} });
	}

	const requestPayload = {
		systemInstruction: { parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }] },
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		tools,
		generationConfig: { temperature: 0, topP: 1 },
	};

	const wrappedBody = {
		project: projectId,
		model: SEARCH_MODEL,
		userAgent: "antigravity",
		requestId: generateRequestId(),
		request: {
			...requestPayload,
			sessionId: getSessionId(),
		},
	};

	const url = `${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`;
	log.debug("Executing search", { query, urlCount: urls?.length ?? 0 });

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				...getAntigravityHeaders(),
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(wrappedBody),
			signal: abortSignal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			const errorText = await response.text();
			log.debug("Search API error", { status: response.status, error: errorText });
			return `## Search Error\n\nFailed to execute search: ${response.status} ${response.statusText}\n\n${errorText}`;
		}

		const data = (await response.json()) as AntigravitySearchResponse;
		const result = parseSearchResponse(data);
		return formatSearchResult(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.debug("Search execution error", { error: message });
		return `## Search Error\n\nFailed to execute search: ${message}`;
	}
}

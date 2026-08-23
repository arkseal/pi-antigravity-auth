/**
 * Constants for the Antigravity OAuth flow and Cloud Code Assist API.
 * Ported from opencode-antigravity-auth-updated/src/constants.ts
 */

export const ANTIGRAVITY_CLIENT_ID =
	"1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

/** Client secret issued for the Antigravity OAuth application. */
export const ANTIGRAVITY_CLIENT_SECRET = "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";

/** Scopes required for Antigravity integrations. */
export const ANTIGRAVITY_SCOPES: readonly string[] = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

/** OAuth redirect URI used by the local callback server. */
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

/**
 * Root endpoints for the Antigravity API (daily sandbox first, prod fallback).
 */
export const ANTIGRAVITY_ENDPOINT_DAILY =
	"https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_PROD,
] as const;

/** Endpoint order for project discovery (prod first). */
export const ANTIGRAVITY_LOAD_ENDPOINTS = [
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_ENDPOINT_DAILY,
] as const;

/** Primary endpoint used for generateContent requests. */
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;

/**
 * Hardcoded project id used when Antigravity does not return one
 * (e.g. business/workspace accounts).
 */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export const ANTIGRAVITY_VERSION_FALLBACK = "1.19.4";

let antigravityVersion = ANTIGRAVITY_VERSION_FALLBACK;
let versionLocked = false;

export function getAntigravityVersion(): string {
	return antigravityVersion;
}

/** Set the runtime Antigravity version once (at startup). Later calls are ignored. */
export function setAntigravityVersion(version: string): void {
	if (versionLocked) return;
	if (version && /^[\w.\-]+$/.test(version)) {
		antigravityVersion = version;
		versionLocked = true;
	}
}

export interface HeaderSet {
	"User-Agent": string;
	"X-Goog-Api-Client"?: string;
	"Client-Metadata"?: string;
}

const ANTIGRAVITY_PLATFORMS = ["windows/amd64", "darwin/arm64", "darwin/amd64"] as const;

const ANTIGRAVITY_API_CLIENTS = [
	"google-cloud-sdk vscode_cloudshelleditor/0.1",
	"google-cloud-sdk vscode/1.96.0",
	"google-cloud-sdk vscode/1.95.0",
] as const;

function randomFrom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Headers that mimic an Antigravity client. Randomized per request to avoid
 * a single fingerprint being associated with all traffic from this machine.
 */
export function getRandomizedAntigravityHeaders(): HeaderSet {
	const platform = randomFrom(ANTIGRAVITY_PLATFORMS);
	const metadataPlatform = platform.startsWith("windows") ? "WINDOWS" : "MACOS";
	return {
		"User-Agent": `antigravity/${getAntigravityVersion()} ${platform}`,
		"X-Goog-Api-Client": randomFrom(ANTIGRAVITY_API_CLIENTS),
		"Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${metadataPlatform}","pluginType":"GEMINI"}`,
	};
}

/** Gemini CLI style headers (used for token exchange / project discovery). */
export const GEMINI_CLI_HEADERS: HeaderSet = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata":
		"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

/**
 * Sentinel value to bypass thought signature validation.
 *
 * When a thinking block has an invalid or missing signature (cache miss,
 * session mismatch), this sentinel can be injected to skip validation instead
 * of failing with "Invalid signature in thinking block". This is an officially
 * supported Google API feature used by gemini-cli and others.
 *
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

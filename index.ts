/**
 * pi-antigravity-auth
 *
 * Full port of opencode-antigravity-auth-updated to the pi coding agent.
 *
 * Registers an `antigravity` provider that authenticates against Google's
 * Antigravity (Cloud Code Assist) API via OAuth, giving access to Gemini 3.x
 * and Claude models through your Google account's Antigravity quota.
 *
 * Features:
 *   - Full model catalog: Gemini 3.8/3.7/3.6/3.5/3.1/3-flash, Claude Opus 4.6 Thinking, Claude Sonnet 4.6, Gemini 2.5 Flash, Image Generation
 *   - Dynamic Antigravity version fetching at startup
 *   - Device fingerprinting with platform/arch rotation
 *   - AccountManager with Storage V4 (proper-lockfile, permissions 0600, migrations)
 *   - Model-family rate limit tracking (claude, gemini-antigravity, gemini-cli)
 *   - Health scoring & token bucket hybrid rotation with sticky account selection
 *   - Proactive background token refresh queue
 *   - Real-time LaTeX to Unicode math formatting during SSE streaming
 *   - Claude thinking block hardening & skip thought signature sentinels
 *   - Gemini OpenAPI schema conversion (type uppercase, required filtering, array items)
 *   - Google Search grounding tool (`antigravity_search`)
 *   - Quota inspection tool (`antigravity_quota`), commands (`/quota`, `/antigravity-quota`, `/antigravity-accounts`, `/antigravity-add-account`)
 *   - TUI persistent quota widget and status bar
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

import {
	authorizeAntigravity,
	exchangeAntigravity,
	refreshAccessToken,
	startOAuthListener,
} from "./src/auth.js";
import { getAccountManager, upsertExtraAccount } from "./src/accounts.js";
import { ANTIGRAVITY_MODELS } from "./src/models.js";
import { ANTIGRAVITY_API_ID, streamAntigravity } from "./src/stream.js";
import { openBrowser } from "./src/browser.js";
import { registerQuotaFeature, refreshCachedQuota } from "./src/quota.js";
import { initAntigravityVersion } from "./src/version.js";
import { createProactiveRefreshQueue } from "./src/refresh-queue.js";

const PROVIDER_ID = "antigravity";
const PROVIDER_NAME = "Google Antigravity";

// ---------------------------------------------------------------------------
// OAuth login flow (browser + localhost callback, with manual fallback)
// ---------------------------------------------------------------------------

async function performBrowserLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const listener = await startOAuthListener();
	const { url } = await authorizeAntigravity();

	callbacks.onProgress?.("Waiting for Google authorization…");
	const opened = openBrowser(url);
	if (!opened) {
		callbacks.onProgress?.("Open this URL in a browser to sign in:");
	}

	try {
		callbacks.onAuth({ url });
		const callbackUrl = await listener.waitForCallback();

		const code = callbackUrl.searchParams.get("code");
		const state = callbackUrl.searchParams.get("state");
		if (!code || !state) {
			throw new Error("OAuth callback missing code/state parameters");
		}

		return await exchangeAntigravity(code, state);
	} finally {
		await listener.close().catch(() => {});
	}
}

async function performManualLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { url } = await authorizeAntigravity();
	callbacks.onAuth({ url });

	const pasted = await callbacks.onPrompt({
		message:
			"Could not listen on localhost:51121. Sign in via the opened URL, then paste the full redirected http://localhost:51121/oauth-callback?… URL here:",
	});
	const trimmed = pasted.trim();
	let callbackUrl: URL;
	try {
		callbackUrl = new URL(trimmed);
	} catch {
		throw new Error("Could not parse the pasted URL — expected the full localhost redirect URL.");
	}
	const code = callbackUrl.searchParams.get("code") ?? trimmed;
	const state = callbackUrl.searchParams.get("state");
	if (!code || !state) {
		throw new Error("Pasted URL is missing the code/state parameters.");
	}
	return exchangeAntigravity(code, state);
}

async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	let credentials: OAuthCredentials;
	try {
		credentials = await performBrowserLogin(callbacks);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			!message.includes("Timed out waiting for OAuth callback") &&
			!message.includes("already in use")
		) {
			throw error;
		}
		credentials = await performManualLogin(callbacks);
	}

	const manager = await getAccountManager();
	await manager.upsertAccount({
		email: (credentials as OAuthCredentials & { email?: string }).email,
		refreshToken: extractRefreshToken(credentials.refresh),
		projectId: extractProjectId(credentials.refresh),
	});

	// Immediately refresh quota cache after login
	refreshCachedQuota().catch(() => {});

	// Offer multi-account setup
	while (
		(await callbacks.onSelect({
			message: "Antigravity account added. Add another Google account for higher combined quota?",
			options: [
				{ id: "yes", label: "Add another account" },
				{ id: "no", label: "Done" },
			],
		})) === "yes"
	) {
		try {
			const extra = await performBrowserLogin(callbacks);
			await manager.upsertAccount({
				email: (extra as OAuthCredentials & { email?: string }).email,
				refreshToken: extractRefreshToken(extra.refresh),
				projectId: extractProjectId(extra.refresh),
			});
			callbacks.onProgress?.(
				`Added account${(extra as OAuthCredentials & { email?: string }).email ? ` (${(extra as OAuthCredentials & { email?: string }).email})` : ""}.`,
			);
		} catch (error) {
			callbacks.onProgress?.(
				`Failed to add account: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
	}

	return credentials;
}

function extractRefreshToken(refresh: string): string {
	return refresh.split("|")[0] ?? "";
}

function extractProjectId(refresh: string): string | undefined {
	return refresh.split("|")[1] || undefined;
}

async function refreshCredentials(
	credentials: OAuthCredentials,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	const refreshToken = extractRefreshToken(credentials.refresh);
	if (!refreshToken) throw new Error("No Antigravity refresh token stored.");

	const refreshed = await refreshAccessToken(refreshToken, signal);
	return {
		refresh:
			refreshed.refreshToken === refreshToken
				? credentials.refresh
				: [refreshed.refreshToken, extractProjectId(credentials.refresh) ?? ""].join("|"),
		access: refreshed.accessToken,
		expires: refreshed.expires,
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function antigravityExtension(pi: ExtensionAPI) {
	// 1. Fetch latest remote Antigravity version in background
	initAntigravityVersion().catch(() => {});

	// 2. Start proactive background token refresh queue
	const refreshQueue = createProactiveRefreshQueue();
	getAccountManager()
		.then((manager) => {
			refreshQueue.setAccountManager(manager);
			refreshQueue.start();
		})
		.catch(() => {});

	// 3. Register custom provider
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
		api: ANTIGRAVITY_API_ID,

		models: ANTIGRAVITY_MODELS,

		oauth: {
			name: "Google Antigravity (OAuth)",
			isSubscription: true,
			login: loginAntigravity,
			refreshToken: refreshCredentials,
			getApiKey: (credentials) => credentials.access,
		},

		streamSimple: streamAntigravity,
	});

	// 4. Register quota inspection, search tool, and account commands
	registerQuotaFeature(pi, PROVIDER_ID);
}

export * from "./src/quota.js";
export * from "./src/models.js";
export * from "./src/math/index.js";

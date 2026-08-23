/**
 * Antigravity OAuth: PKCE authorization URL, local callback server,
 * code exchange, and access-token refresh.
 * Ported from opencode-antigravity-auth-updated/src/antigravity/oauth.ts
 * and src/plugin/{token,server}.ts.
 */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

import {
	ANTIGRAVITY_CLIENT_ID,
	ANTIGRAVITY_CLIENT_SECRET,
	ANTIGRAVITY_LOAD_ENDPOINTS,
	ANTIGRAVITY_REDIRECT_URI,
	ANTIGRAVITY_SCOPES,
	GEMINI_CLI_HEADERS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Refresh-parts encoding (compatible with the opencode plugin's format):
//   "<refreshToken>|<projectId>|<managedProjectId>"
// ---------------------------------------------------------------------------

export interface RefreshParts {
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
}

export function parseRefreshParts(refresh: string): RefreshParts {
	const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
	return {
		refreshToken,
		projectId: projectId || undefined,
		managedProjectId: managedProjectId || undefined,
	};
}

export function formatRefreshParts(parts: RefreshParts): string {
	const projectSegment = parts.projectId ?? "";
	const base = `${parts.refreshToken}|${projectSegment}`;
	return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

export interface OAuthTokens {
	refresh: string;
	access: string;
	expires: number;
	email?: string;
	[key: string]: unknown;
}

/** Calculate absolute expiry timestamp with sane fallback. */
export function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown): number {
	const seconds = typeof expiresInSeconds === "number" && expiresInSeconds > 0 ? expiresInSeconds : 3600;
	return requestTimeMs + seconds * 1000;
}

// ---------------------------------------------------------------------------
// PKCE (implemented with node:crypto to avoid a dependency on @openauthjs)
// ---------------------------------------------------------------------------

interface PkcePair {
	challenge: string;
	verifier: string;
}

function b64url(buffer: Buffer | Uint8Array): string {
	return Buffer.from(buffer).toString("base64url");
}

export async function generatePKCE(): Promise<PkcePair> {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

interface AntigravityAuthState {
	verifier: string;
	projectId: string;
}

function encodeState(payload: AntigravityAuthState): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state: string): AntigravityAuthState {
	const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as Record<string, unknown>;
	if (typeof parsed.verifier !== "string") {
		throw new Error("Missing PKCE verifier in state");
	}
	return {
		verifier: parsed.verifier,
		projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
	};
}

/** Build the Antigravity OAuth authorization URL including PKCE. */
export async function authorizeAntigravity(projectId = ""): Promise<{ url: string }> {
	const pkce = await generatePKCE();

	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
	url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", encodeState({ verifier: pkce.verifier, projectId }));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");

	return { url: url.toString() };
}

// ---------------------------------------------------------------------------
// Local OAuth callback server (localhost:51121)
// ---------------------------------------------------------------------------

const redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI);
const callbackPath = redirectUri.pathname || "/";

const successHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Authentication Successful</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#111827;color:#F9FAFB}
.card{background:#1F2937;border-radius:16px;padding:3rem 2rem;max-width:400px;text-align:center;border:1px solid #374151}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#9CA3AF}
</style></head>
<body><div class="card"><h1>&#10003; All set!</h1><p>You've successfully authenticated with Antigravity. You can now return to pi.</p></div></body></html>`;

export interface OAuthListener {
	waitForCallback(): Promise<URL>;
	close(): Promise<void>;
}

/**
 * Start a lightweight HTTP server listening for the OAuth redirect.
 * Falls back gracefully when the port is taken by a previous run of the same
 * login attempt (the stale server will die eventually).
 */
export async function startOAuthListener(timeoutMs = 5 * 60 * 1000): Promise<OAuthListener> {
	const port = Number.parseInt(redirectUri.port ?? "80", 10);
	const origin = `${redirectUri.protocol}//${redirectUri.host}`;

	let settled = false;
	let resolveCallback: (url: URL) => void = () => {};
	let rejectCallback: (error: Error) => void = () => {};

	const callbackPromise = new Promise<URL>((resolve, reject) => {
		resolveCallback = (url) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);
			resolve(url);
		};
		rejectCallback = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);
			reject(error);
		};
	});

	const timeoutHandle = setTimeout(() => {
		rejectCallback(new Error("Timed out waiting for OAuth callback"));
	}, timeoutMs);
	timeoutHandle.unref?.();

	const server: Server = createServer((request, response) => {
		if (!request.url) {
			response.writeHead(400, { "Content-Type": "text/plain" });
			response.end("Invalid request");
			return;
		}
		const url = new URL(request.url, origin);
		if (url.pathname !== callbackPath) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("Not found");
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(successHtml);
		resolveCallback(url);
		setImmediate(() => server.close());
	});

	await new Promise<void>((resolve, reject) => {
		const handleError = (error: NodeJS.ErrnoException) => {
			server.off("error", handleError);
			if (error.code === "EADDRINUSE") {
				reject(
					new Error(
						`Port ${port} is already in use. Kill the process using it and try again.`,
					),
				);
				return;
			}
			reject(error);
		};
		server.once("error", handleError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", handleError);
			resolve();
		});
	});

	server.on("error", (error) => {
		rejectCallback(error instanceof Error ? error : new Error(String(error)));
	});

	return {
		waitForCallback: () => callbackPromise,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				if (!settled) rejectCallback(new Error("OAuth listener closed before callback"));
				resolve();
			}),
	};
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

/** Resolve the user's cloudaicompanion project id via loadCodeAssist. */
export async function fetchProjectID(accessToken: string): Promise<string> {
	const errors: string[] = [];
	const loadHeaders: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": GEMINI_CLI_HEADERS["User-Agent"]!,
		"Client-Metadata": GEMINI_CLI_HEADERS["Client-Metadata"]!,
	};

	for (const baseEndpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
		try {
			const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
			const response = await fetchWithTimeout(url, {
				method: "POST",
				headers: loadHeaders,
				body: JSON.stringify({
					metadata: {
						ideType: "ANTIGRAVITY",
						platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
						pluginType: "GEMINI",
					},
				}),
			});

			if (!response.ok) {
				const message = await response.text().catch(() => "");
				errors.push(`loadCodeAssist ${response.status} at ${baseEndpoint}${message ? `: ${message}` : ""}`);
				continue;
			}

			const data = (await response.json()) as {
				cloudaicompanionProject?: string | { id?: string };
			};
			const project = data.cloudaicompanionProject;
			if (typeof project === "string" && project) return project;
			if (project && typeof project === "object" && typeof project.id === "string" && project.id) {
				return project.id;
			}
			errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
		} catch (e) {
			errors.push(`loadCodeAssist error at ${baseEndpoint}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	if (errors.length) {
		console.warn(`[pi-antigravity-auth] Failed to resolve project: ${errors.join("; ")}`);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
}

/**
 * Exchange an authorization code (captured from the callback URL) for tokens.
 */
export async function exchangeAntigravity(code: string, state: string): Promise<OAuthTokens> {
	const { verifier, projectId } = decodeState(state);

	const startTime = Date.now();
	const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			Accept: "*/*",
			"User-Agent": GEMINI_CLI_HEADERS["User-Agent"]!,
		},
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: ANTIGRAVITY_REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		throw new Error(`Token exchange failed (${tokenResponse.status}): ${await tokenResponse.text()}`);
	}

	const tokenPayload = (await tokenResponse.json()) as GoogleTokenResponse;

	let email: string | undefined;
	try {
		const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${tokenPayload.access_token}`,
				"User-Agent": GEMINI_CLI_HEADERS["User-Agent"]!,
			},
		});
		if (userInfoResponse.ok) {
			const info = (await userInfoResponse.json()) as { email?: string };
			email = info.email;
		}
	} catch {
		// Email is optional metadata.
	}

	if (!tokenPayload.refresh_token) {
		throw new Error("Missing refresh token in token response");
	}

	let effectiveProjectId = projectId;
	if (!effectiveProjectId) {
		effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
	}

	return {
		refresh: formatRefreshParts({
			refreshToken: tokenPayload.refresh_token,
			projectId: effectiveProjectId || undefined,
		}),
		access: tokenPayload.access_token,
		expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
		email,
	};
}

export class AntigravityTokenRefreshError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "AntigravityTokenRefreshError";
	}
}

/**
 * Refresh an access token using a refresh token. Returns the (possibly
 * rotated) refresh token alongside the new access token.
 */
export async function refreshAccessToken(
	refreshToken: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; expires: number; refreshToken: string }> {
	const startTime = Date.now();
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
		}),
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let code: string | undefined;
		try {
			const payload = JSON.parse(text) as { error?: string };
			code = typeof payload.error === "string" ? payload.error : undefined;
		} catch {
			// ignore
		}
		throw new AntigravityTokenRefreshError(
			`Antigravity token refresh failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`,
			code,
		);
	}

	const payload = (await response.json()) as GoogleTokenResponse;
	return {
		accessToken: payload.access_token,
		expires: calculateTokenExpiry(startTime, payload.expires_in),
		refreshToken: payload.refresh_token ?? refreshToken,
	};
}

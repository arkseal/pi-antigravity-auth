/**
 * Multi-account pool: persistent storage and rate-limit aware rotation.
 * Ported (simplified) from opencode-antigravity-auth-updated/src/plugin/{storage,accounts}.ts
 *
 * The primary account lives in pi's own auth.json (managed via /login).
 * Additional accounts are stored in <agent-dir>/antigravity-accounts.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { parseRefreshParts, refreshAccessToken } from "./auth.js";

export interface StoredAccount {
	email?: string;
	refreshToken: string;
	projectId?: string;
	addedAt?: number;
	lastUsed?: number;
	enabled?: boolean;
}

interface AccountPoolFile {
	version: 1;
	accounts: StoredAccount[];
}

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function accountsFilePath(): string {
	return join(agentDir(), "antigravity-accounts.json");
}

/** The in-memory token cache: refreshToken -> { accessToken, expires } */
interface CachedToken {
	accessToken: string;
	expires: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Rate-limit state: account key -> blocked-until timestamp. */
const blockedUntil = new Map<string, number>();

function accountKey(account: PoolAccount): string {
	return account.refreshToken ? account.refreshToken.slice(-24) : account.email ?? "unknown";
}

export interface PoolAccount {
	email?: string;
	refreshToken: string;
	projectId?: string;
	/** Where this account comes from. */
	source: "primary" | "pool";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadExtraAccounts(): StoredAccount[] {
	try {
		const path = accountsFilePath();
		if (!existsSync(path)) return [];
		const parsed = JSON.parse(readFileSync(path, "utf8")) as AccountPoolFile;
		if (!Array.isArray(parsed.accounts)) return [];
		return parsed.accounts.filter((a) => a && typeof a.refreshToken === "string" && a.refreshToken);
	} catch {
		return [];
	}
}

export function saveExtraAccounts(accounts: StoredAccount[]): void {
	const dir = agentDir();
	mkdirSync(dir, { recursive: true });
	const payload: AccountPoolFile = { version: 1, accounts };
	writeFileSync(accountsFilePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/** Insert or update an extra account (matched by email first, then token). */
export function upsertExtraAccount(account: {
	email?: string;
	refreshToken: string;
	projectId?: string;
}): void {
	const accounts = loadExtraAccounts();
	const now = Date.now();

	const byEmail = account.email ? accounts.findIndex((a) => a.email === account.email) : -1;
	const byToken = accounts.findIndex((a) => a.refreshToken === account.refreshToken);
	const index = byEmail >= 0 ? byEmail : byToken;

	if (index < 0) {
		accounts.push({ ...account, addedAt: now, lastUsed: now, enabled: true });
	} else {
		const existing = accounts[index]!;
		accounts[index] = {
			...existing,
			email: account.email ?? existing.email,
			refreshToken: account.refreshToken,
			projectId: existing.projectId ?? account.projectId,
			lastUsed: now,
			enabled: existing.enabled !== false,
		};
	}
	saveExtraAccounts(accounts);
}

/**
 * Read the primary account from pi's auth.json (written by /login).
 * Returns undefined when the user has not authenticated yet.
 */
export function readPrimaryAccount(providerId: string): PoolAccount | undefined {
	try {
		const path = join(agentDir(), "auth.json");
		if (!existsSync(path)) return undefined;
		const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const entry = auth[providerId] as
			| { type?: string; refresh?: string; access?: string; expires?: number }
			| undefined;
		if (!entry || typeof entry.refresh !== "string") return undefined;
		const parts = parseRefreshParts(entry.refresh);
		if (!parts.refreshToken) return undefined;
		// Reuse pi's still-valid access token so we don't refresh unnecessarily.
		const cached = tokenCache.get(parts.refreshToken);
		if (
			!cached &&
			typeof entry.access === "string" &&
			entry.access &&
			typeof entry.expires === "number" &&
			entry.expires > Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS
		) {
			tokenCache.set(parts.refreshToken, { accessToken: entry.access, expires: entry.expires });
		}
		return {
			email: undefined,
			refreshToken: parts.refreshToken,
			projectId: parts.projectId ?? parts.managedProjectId,
			source: "primary",
		};
	} catch {
		return undefined;
	}
}

/**
 * All usable accounts: primary first (from auth.json), then extras from the
 * pool file. De-duplicated by refresh token.
 */
export function getAllAccounts(providerId: string): PoolAccount[] {
	const result: PoolAccount[] = [];
	const seenTokens = new Set<string>();

	const primary = readPrimaryAccount(providerId);
	if (primary) {
		result.push(primary);
		seenTokens.add(primary.refreshToken);
	}

	for (const extra of loadExtraAccounts()) {
		if (extra.enabled === false) continue;
		if (seenTokens.has(extra.refreshToken)) continue;
		seenTokens.add(extra.refreshToken);
		result.push({
			email: extra.email,
			refreshToken: extra.refreshToken,
			projectId: extra.projectId,
			source: "pool",
		});
	}

	return result;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function isTokenUsable(cached: CachedToken | undefined): boolean {
	return !!cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

/** Get a valid access token for an account, refreshing it if needed. */
export async function getAccessToken(
	account: PoolAccount,
	signal?: AbortSignal,
): Promise<{ accessToken: string; projectId?: string }> {
	const cached = tokenCache.get(account.refreshToken);
	if (isTokenUsable(cached)) {
		return { accessToken: cached!.accessToken, projectId: account.projectId };
	}

	const refreshed = await refreshAccessToken(account.refreshToken, signal);

	// Persist rotated refresh tokens for pool-managed extras.
	if (refreshed.refreshToken !== account.refreshToken && account.source === "pool") {
		upsertExtraAccount({
			email: account.email,
			refreshToken: refreshed.refreshToken,
			projectId: account.projectId,
		});
		tokenCache.delete(account.refreshToken);
		blockedUntil.delete(accountKey(account));
		account.refreshToken = refreshed.refreshToken;
	}

	tokenCache.set(refreshed.refreshToken, {
		accessToken: refreshed.accessToken,
		expires: refreshed.expires,
	});

	return { accessToken: refreshed.accessToken, projectId: account.projectId };
}

// ---------------------------------------------------------------------------
// Rate-limit rotation
// ---------------------------------------------------------------------------

export function markRateLimited(account: PoolAccount, untilMs: number): void {
	const key = accountKey(account);
	const current = blockedUntil.get(key) ?? 0;
	blockedUntil.set(key, Math.max(current, untilMs));
}

export function markHealthy(account: PoolAccount): void {
	blockedUntil.delete(accountKey(account));
}

export function getBlockedUntil(account: PoolAccount): number {
	return blockedUntil.get(accountKey(account)) ?? 0;
}

/**
 * Pick the next usable account, rotating through the pool starting after
 * `afterIndex`. Returns the index into `accounts`, or -1 when all are blocked
 * (in which case `soonestResetMs` reports when the earliest one recovers).
 */
export function selectAccount(
	accounts: PoolAccount[],
	afterIndex: number,
): { index: number; soonestResetMs: number } {
	const n = accounts.length;
	let soonestResetMs = Number.POSITIVE_INFINITY;

	for (let i = 1; i <= n; i++) {
		const index = (afterIndex + i) % n;
		const account = accounts[index]!;
		const until = getBlockedUntil(account);
		if (until <= Date.now()) {
			return { index, soonestResetMs };
		}
		soonestResetMs = Math.min(soonestResetMs, until);
	}

	return { index: -1, soonestResetMs };
}

/** First non-blocked account index (prefers the primary), or -1. */
export function selectInitialAccount(accounts: PoolAccount[]): number {
	for (let i = 0; i < accounts.length; i++) {
		if (getBlockedUntil(accounts[i]!) <= Date.now()) return i;
	}
	return -1;
}

/** Human-readable label for log/error messages. */
export function describeAccount(account: PoolAccount, index: number): string {
	return account.email ? `${account.email} (#${index + 1})` : `account #${index + 1}`;
}

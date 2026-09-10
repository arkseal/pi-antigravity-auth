/**
 * Multi-account pool: persistent storage, health tracking, and rate-limit aware rotation.
 * Ported from opencode-antigravity-auth-updated/src/plugin/accounts.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	loadAccounts,
	saveAccounts,
	type AccountStorageV4,
	type StoredAccountV4,
	type ModelFamily,
	type CooldownReason,
	getAgentDir,
} from "./storage.js";
import {
	generateFingerprint,
	updateFingerprintVersion,
	type Fingerprint,
	type FingerprintVersion,
	MAX_FINGERPRINT_HISTORY,
} from "./fingerprint.js";
import {
	getHealthTracker,
	getTokenTracker,
	selectHybridAccount,
	type AccountWithMetrics,
} from "./rotation.js";
import { parseRefreshParts, refreshAccessToken } from "./auth.js";
import { getModelFamily } from "./model-resolver.js";
import { createLogger } from "./logger.js";
import { parseDurationToMs } from "./logging-utils.js";

const log = createLogger("accounts");

export type { ModelFamily, CooldownReason };

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45_000;
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000;
const SERVER_ERROR_BACKOFF = 20_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

function generateJitter(maxJitterMs: number): number {
	return Math.random() * maxJitterMs - maxJitterMs / 2;
}

export function parseRateLimitReason(
	reason: string | undefined,
	message: string | undefined,
	status?: number,
): RateLimitReason {
	if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED";
	if (status === 500) return "SERVER_ERROR";

	if (reason) {
		switch (reason.toUpperCase()) {
			case "QUOTA_EXHAUSTED":
				return "QUOTA_EXHAUSTED";
			case "RATE_LIMIT_EXCEEDED":
				return "RATE_LIMIT_EXCEEDED";
			case "MODEL_CAPACITY_EXHAUSTED":
				return "MODEL_CAPACITY_EXHAUSTED";
		}
	}

	if (message) {
		const lower = message.toLowerCase();
		if (
			lower.includes("capacity") ||
			lower.includes("overloaded") ||
			lower.includes("resource exhausted")
		) {
			return "MODEL_CAPACITY_EXHAUSTED";
		}
		if (
			lower.includes("per minute") ||
			lower.includes("rate limit") ||
			lower.includes("too many requests") ||
			lower.includes("presque")
		) {
			return "RATE_LIMIT_EXCEEDED";
		}
		if (lower.includes("exhausted") || lower.includes("quota")) {
			return "QUOTA_EXHAUSTED";
		}
	}

	return "UNKNOWN";
}

export function calculateBackoffMs(
	reason: RateLimitReason,
	consecutiveFailures: number,
	retryAfterMs?: number | null,
): number {
	if (retryAfterMs && retryAfterMs > 0) {
		return Math.max(retryAfterMs, MIN_BACKOFF_MS);
	}
	switch (reason) {
		case "QUOTA_EXHAUSTED": {
			const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
			return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
		}
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX);
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF;
		case "UNKNOWN":
		default:
			return UNKNOWN_BACKOFF;
	}
}

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";

export interface ManagedAccount {
	index: number;
	email?: string;
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
	addedAt: number;
	lastUsed: number;
	access?: string;
	expires?: number;
	enabled: boolean;
	rateLimitResetTimes: Record<string, number | undefined>;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	consecutiveFailures?: number;
	lastFailureTime?: number;
	fingerprint?: Fingerprint;
	fingerprintHistory?: FingerprintVersion[];
	verificationRequired?: boolean;
	verificationRequiredAt?: number;
	verificationRequiredReason?: string;
	verificationUrl?: string;
	cachedQuota?: Record<string, unknown>;
	source: "primary" | "pool";
}

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FAILURE_COUNT_TTL_MS = 30 * 60 * 1000;

export class AccountManager {
	private accounts: ManagedAccount[] = [];
	private activeIndex = 0;
	private loaded = false;
	private stickyAccountByFamily = new Map<string, number>();

	async load(): Promise<void> {
		const storage = await loadAccounts();
		this.accounts = storage.accounts.map((acc, index) => ({
			...acc,
			index,
			source: "pool" as const,
		}));
		this.activeIndex = Math.max(0, Math.min(storage.activeIndex, this.accounts.length - 1));

		// Sync primary account from auth.json
		this.syncPrimaryAccount();

		// Ensure fingerprints exist and versions are updated
		for (const acc of this.accounts) {
			if (!acc.fingerprint) {
				acc.fingerprint = generateFingerprint();
			} else {
				updateFingerprintVersion(acc.fingerprint);
			}
		}

		this.loaded = true;
	}

	syncPrimaryAccount(): void {
		try {
			const path = join(getAgentDir(), "auth.json");
			if (!existsSync(path)) return;
			const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const entry = auth.antigravity as
				| { type?: string; refresh?: string; access?: string; expires?: number; email?: string }
				| undefined;
			if (!entry || typeof entry.refresh !== "string") return;
			const parts = parseRefreshParts(entry.refresh);
			if (!parts.refreshToken) return;

			const existing = this.accounts.find((a) => a.refreshToken === parts.refreshToken);
			if (!existing) {
				const newAcc: ManagedAccount = {
					index: this.accounts.length,
					email: entry.email,
					refreshToken: parts.refreshToken,
					projectId: parts.projectId,
					managedProjectId: parts.managedProjectId,
					addedAt: Date.now(),
					lastUsed: Date.now(),
					access: entry.access,
					expires: entry.expires,
					enabled: true,
					rateLimitResetTimes: {},
					source: "primary",
					fingerprint: generateFingerprint(),
				};
				this.accounts.unshift(newAcc);
				this.reindex();
			} else {
				if (entry.email && !existing.email) existing.email = entry.email;
				if (entry.access) existing.access = entry.access;
				if (entry.expires) existing.expires = entry.expires;
				if (parts.projectId && !existing.projectId) existing.projectId = parts.projectId;
				if (parts.managedProjectId && !existing.managedProjectId)
					existing.managedProjectId = parts.managedProjectId;
			}
		} catch {
			// Ignore
		}
	}

	private reindex(): void {
		for (let i = 0; i < this.accounts.length; i++) {
			this.accounts[i]!.index = i;
		}
	}

	async save(): Promise<void> {
		const payload: AccountStorageV4 = {
			version: 4,
			activeIndex: this.activeIndex,
			accounts: this.accounts.map((acc) => ({
				email: acc.email,
				refreshToken: acc.refreshToken,
				projectId: acc.projectId,
				managedProjectId: acc.managedProjectId,
				addedAt: acc.addedAt,
				lastUsed: acc.lastUsed,
				enabled: acc.enabled,
				rateLimitResetTimes: acc.rateLimitResetTimes,
				lastSwitchReason: acc.lastSwitchReason,
				coolingDownUntil: acc.coolingDownUntil,
				cooldownReason: acc.cooldownReason,
				consecutiveFailures: acc.consecutiveFailures,
				lastFailureTime: acc.lastFailureTime,
				fingerprint: acc.fingerprint,
				fingerprintHistory: acc.fingerprintHistory,
				verificationRequired: acc.verificationRequired,
				verificationRequiredAt: acc.verificationRequiredAt,
				verificationRequiredReason: acc.verificationRequiredReason,
				verificationUrl: acc.verificationUrl,
				cachedQuota: acc.cachedQuota,
			})),
		};
		await saveAccounts(payload);
	}

	getAccounts(): ManagedAccount[] {
		return [...this.accounts];
	}

	getAccountByIndex(index: number): ManagedAccount | undefined {
		return this.accounts[index];
	}

	getQuotaKey(modelFamily: ModelFamily, preferCli = false): BaseQuotaKey {
		if (modelFamily === "claude") return "claude";
		return preferCli ? "gemini-cli" : "gemini-antigravity";
	}

	isAccountRateLimited(account: ManagedAccount, quotaKey: BaseQuotaKey): boolean {
		const resetTime = account.rateLimitResetTimes[quotaKey];
		if (!resetTime) return false;
		return Date.now() < resetTime;
	}

	isAccountCoolingDown(account: ManagedAccount): boolean {
		if (!account.coolingDownUntil) return false;
		return Date.now() < account.coolingDownUntil;
	}

	getSoonestResetTime(modelFamily: ModelFamily, preferCli = false): number {
		const quotaKey = this.getQuotaKey(modelFamily, preferCli);
		let soonest = Number.POSITIVE_INFINITY;
		for (const acc of this.accounts) {
			if (!acc.enabled || acc.verificationRequired) continue;
			const reset = acc.rateLimitResetTimes[quotaKey] ?? 0;
			const cool = acc.coolingDownUntil ?? 0;
			const until = Math.max(reset, cool);
			if (until <= Date.now()) return Date.now();
			soonest = Math.min(soonest, until);
		}
		return soonest;
	}

	selectAccount(modelId: string, preferCli = false): ManagedAccount | null {
		const family = getModelFamily(modelId);
		const modelFamily: ModelFamily = family === "claude" ? "claude" : "gemini";
		const quotaKey = this.getQuotaKey(modelFamily, preferCli);

		const availableAccounts = this.accounts.filter(
			(acc) => acc.enabled && !acc.verificationRequired,
		);

		if (availableAccounts.length === 0) return null;

		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		const metrics: AccountWithMetrics[] = availableAccounts.map((acc) => ({
			index: acc.index,
			lastUsed: acc.lastUsed,
			healthScore: healthTracker.getScore(acc.index),
			isRateLimited: this.isAccountRateLimited(acc, quotaKey),
			isCoolingDown: this.isAccountCoolingDown(acc),
		}));

		const stickyIndex = this.stickyAccountByFamily.get(quotaKey) ?? null;
		const selectedIndex = selectHybridAccount(metrics, tokenTracker, stickyIndex);

		if (selectedIndex !== null) {
			const selected = this.accounts[selectedIndex];
			if (selected) {
				this.stickyAccountByFamily.set(quotaKey, selectedIndex);
				this.activeIndex = selectedIndex;
				return selected;
			}
		}

		// Fallback: pick any non-rate-limited account
		for (const acc of availableAccounts) {
			if (!this.isAccountRateLimited(acc, quotaKey) && !this.isAccountCoolingDown(acc)) {
				this.stickyAccountByFamily.set(quotaKey, acc.index);
				this.activeIndex = acc.index;
				return acc;
			}
		}

		return null;
	}

	async getAccessTokenForAccount(
		account: ManagedAccount,
		signal?: AbortSignal,
	): Promise<{ accessToken: string; projectId?: string }> {
		const now = Date.now();
		if (
			account.access &&
			account.expires &&
			account.expires > now + ACCESS_TOKEN_EXPIRY_BUFFER_MS
		) {
			return {
				accessToken: account.access,
				projectId: account.projectId ?? account.managedProjectId,
			};
		}

		const refreshed = await refreshAccessToken(account.refreshToken, signal);
		account.access = refreshed.accessToken;
		account.expires = refreshed.expires;

		if (refreshed.refreshToken !== account.refreshToken) {
			account.refreshToken = refreshed.refreshToken;
			await this.save().catch(() => {});
		}

		return {
			accessToken: refreshed.accessToken,
			projectId: account.projectId ?? account.managedProjectId,
		};
	}

	recordSuccess(account: ManagedAccount, modelFamily: ModelFamily): void {
		account.lastUsed = Date.now();
		getHealthTracker().recordSuccess(account.index);

		// Reset consecutive failures if TTL passed
		if (
			account.lastFailureTime &&
			Date.now() - account.lastFailureTime > FAILURE_COUNT_TTL_MS
		) {
			account.consecutiveFailures = 0;
		}
	}

	recordRateLimit(
		account: ManagedAccount,
		modelFamily: ModelFamily,
		reason: RateLimitReason,
		status?: number,
		retryAfterMs?: number | null,
	): number {
		const quotaKey = this.getQuotaKey(modelFamily);
		const failures = (account.consecutiveFailures ?? 0) + 1;
		account.consecutiveFailures = failures;
		account.lastFailureTime = Date.now();

		const backoffMs = calculateBackoffMs(reason, failures, retryAfterMs);
		const until = Date.now() + backoffMs;

		account.rateLimitResetTimes[quotaKey] = until;
		getHealthTracker().recordRateLimit(account.index);

		// If capacity exhausted, regenerate device fingerprint
		if (reason === "MODEL_CAPACITY_EXHAUSTED" && account.fingerprint) {
			if (!account.fingerprintHistory) account.fingerprintHistory = [];
			account.fingerprintHistory.unshift({
				fingerprint: account.fingerprint,
				timestamp: Date.now(),
				reason: "regenerated",
			});
			if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
				account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
			}
			account.fingerprint = generateFingerprint();
		}

		this.save().catch(() => {});
		return backoffMs;
	}

	markAccountVerificationRequired(account: ManagedAccount, reason: string, url?: string): void {
		account.enabled = false;
		account.verificationRequired = true;
		account.verificationRequiredAt = Date.now();
		account.verificationRequiredReason = reason;
		account.verificationUrl = url;
		account.coolingDownUntil = Date.now() + 24 * 60 * 60 * 1000;
		account.cooldownReason = "verification";
		this.save().catch(() => {});
	}

	clearAccountVerification(account: ManagedAccount): void {
		account.enabled = true;
		account.verificationRequired = false;
		account.verificationRequiredAt = undefined;
		account.verificationRequiredReason = undefined;
		account.verificationUrl = undefined;
		account.coolingDownUntil = undefined;
		account.cooldownReason = undefined;
		this.save().catch(() => {});
	}

	setAccountEnabled(index: number, enabled: boolean): void {
		const account = this.accounts[index];
		if (!account) return;
		account.enabled = enabled;
		this.save().catch(() => {});
	}

	async removeAccount(index: number): Promise<boolean> {
		if (index < 0 || index >= this.accounts.length) return false;
		const removed = this.accounts.splice(index, 1)[0];
		getHealthTracker().reset(index);
		this.reindex();
		if (this.activeIndex >= this.accounts.length) {
			this.activeIndex = Math.max(0, this.accounts.length - 1);
		}
		await this.save();
		return !!removed;
	}

	async upsertAccount(account: {
		email?: string;
		refreshToken: string;
		projectId?: string;
		managedProjectId?: string;
	}): Promise<ManagedAccount> {
		const now = Date.now();
		const byEmail = account.email ? this.accounts.find((a) => a.email === account.email) : undefined;
		const byToken = this.accounts.find((a) => a.refreshToken === account.refreshToken);
		const existing = byEmail ?? byToken;

		if (!existing) {
			const created: ManagedAccount = {
				index: this.accounts.length,
				email: account.email,
				refreshToken: account.refreshToken,
				projectId: account.projectId,
				managedProjectId: account.managedProjectId,
				addedAt: now,
				lastUsed: now,
				enabled: true,
				rateLimitResetTimes: {},
				source: "pool",
				fingerprint: generateFingerprint(),
			};
			this.accounts.push(created);
			await this.save();
			return created;
		}

		existing.email = account.email ?? existing.email;
		existing.refreshToken = account.refreshToken;
		existing.projectId = account.projectId ?? existing.projectId;
		existing.managedProjectId = account.managedProjectId ?? existing.managedProjectId;
		existing.lastUsed = now;
		existing.enabled = true;
		await this.save();
		return existing;
	}
}

let globalAccountManager: AccountManager | null = null;

export async function getAccountManager(): Promise<AccountManager> {
	if (!globalAccountManager) {
		globalAccountManager = new AccountManager();
		await globalAccountManager.load();
	} else {
		globalAccountManager.syncPrimaryAccount();
	}
	return globalAccountManager;
}

// ---------------------------------------------------------------------------
// Compatibility helpers
// ---------------------------------------------------------------------------

export interface PoolAccount {
	email?: string;
	refreshToken: string;
	projectId?: string;
	source: "primary" | "pool";
}

export function getAllAccounts(_providerId = "antigravity"): PoolAccount[] {
	if (globalAccountManager) {
		return globalAccountManager.getAccounts().map((a) => ({
			email: a.email,
			refreshToken: a.refreshToken,
			projectId: a.projectId ?? a.managedProjectId,
			source: a.source,
		}));
	}
	// Fallback to reading disk synchronously
	try {
		const path = join(getAgentDir(), "antigravity-accounts.json");
		const res: PoolAccount[] = [];
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as AccountStorageV4;
			if (Array.isArray(parsed.accounts)) {
				for (const a of parsed.accounts) {
					if (a.refreshToken && a.enabled !== false) {
						res.push({
							email: a.email,
							refreshToken: a.refreshToken,
							projectId: a.projectId ?? a.managedProjectId,
							source: "pool",
						});
					}
				}
			}
		}
		return res;
	} catch {
		return [];
	}
}

export async function getAccessToken(
	account: PoolAccount,
	signal?: AbortSignal,
): Promise<{ accessToken: string; projectId?: string }> {
	const mgr = await getAccountManager();
	const managed = mgr.getAccounts().find((a) => a.refreshToken === account.refreshToken);
	if (managed) {
		return mgr.getAccessTokenForAccount(managed, signal);
	}
	const refreshed = await refreshAccessToken(account.refreshToken, signal);
	return { accessToken: refreshed.accessToken, projectId: account.projectId };
}

export function upsertExtraAccount(account: {
	email?: string;
	refreshToken: string;
	projectId?: string;
}): void {
	void (async () => {
		const mgr = await getAccountManager();
		await mgr.upsertAccount(account);
	})();
}

export function markRateLimited(account: PoolAccount, untilMs: number): void {
	void (async () => {
		const mgr = await getAccountManager();
		const managed = mgr.getAccounts().find((a) => a.refreshToken === account.refreshToken);
		if (managed) {
			managed.rateLimitResetTimes["gemini-antigravity"] = untilMs;
			managed.rateLimitResetTimes["claude"] = untilMs;
			await mgr.save();
		}
	})();
}

export function markHealthy(account: PoolAccount): void {
	void (async () => {
		const mgr = await getAccountManager();
		const managed = mgr.getAccounts().find((a) => a.refreshToken === account.refreshToken);
		if (managed) {
			managed.rateLimitResetTimes = {};
			await mgr.save();
		}
	})();
}

export function getBlockedUntil(account: PoolAccount): number {
	if (!globalAccountManager) return 0;
	const managed = globalAccountManager.getAccounts().find((a) => a.refreshToken === account.refreshToken);
	if (!managed) return 0;
	const resets = Object.values(managed.rateLimitResetTimes).filter(
		(v): v is number => typeof v === "number",
	);
	if (resets.length === 0) return 0;
	return Math.max(...resets);
}

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

export function selectInitialAccount(accounts: PoolAccount[]): number {
	for (let i = 0; i < accounts.length; i++) {
		if (getBlockedUntil(accounts[i]!) <= Date.now()) return i;
	}
	return -1;
}

export function describeAccount(account: PoolAccount, index: number): string {
	return account.email ? `${account.email} (#${index + 1})` : `account #${index + 1}`;
}

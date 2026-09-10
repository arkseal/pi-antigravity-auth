/**
 * Persistent Storage for Antigravity Accounts (Storage V4).
 * Ported from opencode-antigravity-auth-updated/src/plugin/storage.ts
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	mkdirSync,
	chmodSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as lockfileModule from "proper-lockfile";

import type { Fingerprint, FingerprintVersion } from "./fingerprint.js";
import { createLogger } from "./logger.js";

const lockfile = (
	(lockfileModule as { default?: unknown }).default ?? lockfileModule
) as typeof import("proper-lockfile");

const log = createLogger("storage");

export const GITIGNORE_ENTRIES = [
	".gitignore",
	"antigravity-accounts.json",
	"antigravity-accounts.json.*.tmp",
	"antigravity-signature-cache.json",
	"antigravity-logs/",
];

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getStoragePath(): string {
	return join(getAgentDir(), "antigravity-accounts.json");
}

export function ensureGitignore(configDir: string): void {
	const gitignorePath = join(configDir, ".gitignore");
	try {
		let content = "";
		let existingLines: string[] = [];
		if (existsSync(gitignorePath)) {
			content = readFileSync(gitignorePath, "utf-8");
			existingLines = content.split("\n").map((line) => line.trim());
		}
		const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));
		if (missingEntries.length === 0) return;
		if (content === "") {
			writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
		} else {
			const suffix = content.endsWith("\n") ? "" : "\n";
			appendFileSync(gitignorePath, suffix + missingEntries.join("\n") + "\n", "utf-8");
		}
	} catch {
		// Non-critical
	}
}

export type ModelFamily = "claude" | "gemini";
export type CooldownReason = "rate-limit" | "capacity" | "quota" | "verification" | "manual";

export interface RateLimitStateV3 {
	claude?: number;
	"gemini-antigravity"?: number;
	"gemini-cli"?: number;
	[key: string]: number | undefined;
}

export interface StoredAccountV4 {
	email?: string;
	refreshToken: string;
	projectId?: string;
	managedProjectId?: string;
	addedAt: number;
	lastUsed: number;
	enabled: boolean;
	rateLimitResetTimes: RateLimitStateV3;
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
}

export interface AccountStorageV4 {
	version: 4;
	activeIndex: number;
	accounts: StoredAccountV4[];
}

function migrateToV4(raw: Record<string, unknown>): AccountStorageV4 {
	const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
	const accounts: StoredAccountV4[] = rawAccounts.map((acc: Record<string, unknown>) => {
		const rateLimit = (acc.rateLimitResetTimes as Record<string, number> | undefined) ?? {};
		return {
			email: typeof acc.email === "string" ? acc.email : undefined,
			refreshToken: typeof acc.refreshToken === "string" ? acc.refreshToken : "",
			projectId: typeof acc.projectId === "string" ? acc.projectId : undefined,
			managedProjectId: typeof acc.managedProjectId === "string" ? acc.managedProjectId : undefined,
			addedAt: typeof acc.addedAt === "number" ? acc.addedAt : Date.now(),
			lastUsed: typeof acc.lastUsed === "number" ? acc.lastUsed : Date.now(),
			enabled: acc.enabled !== false,
			rateLimitResetTimes: rateLimit,
			lastSwitchReason: acc.lastSwitchReason as StoredAccountV4["lastSwitchReason"],
			coolingDownUntil: typeof acc.coolingDownUntil === "number" ? acc.coolingDownUntil : undefined,
			cooldownReason: acc.cooldownReason as CooldownReason | undefined,
			consecutiveFailures: typeof acc.consecutiveFailures === "number" ? acc.consecutiveFailures : 0,
			lastFailureTime: typeof acc.lastFailureTime === "number" ? acc.lastFailureTime : undefined,
			fingerprint: acc.fingerprint as Fingerprint | undefined,
			fingerprintHistory: Array.isArray(acc.fingerprintHistory)
				? (acc.fingerprintHistory as FingerprintVersion[])
				: undefined,
			verificationRequired: acc.verificationRequired === true,
			verificationRequiredAt:
				typeof acc.verificationRequiredAt === "number" ? acc.verificationRequiredAt : undefined,
			verificationRequiredReason:
				typeof acc.verificationRequiredReason === "string" ? acc.verificationRequiredReason : undefined,
			verificationUrl: typeof acc.verificationUrl === "string" ? acc.verificationUrl : undefined,
			cachedQuota: acc.cachedQuota as Record<string, unknown> | undefined,
		};
	}).filter((a) => a.refreshToken);

	return {
		version: 4,
		activeIndex: typeof raw.activeIndex === "number" ? raw.activeIndex : 0,
		accounts,
	};
}

export async function loadAccounts(): Promise<AccountStorageV4> {
	const storagePath = getStoragePath();
	const configDir = getAgentDir();
	ensureGitignore(configDir);

	if (!existsSync(storagePath)) {
		return { version: 4, activeIndex: 0, accounts: [] };
	}

	try {
		chmodSync(storagePath, 0o600);
	} catch {
		// Ignore
	}

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(storagePath, {
			retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
			stale: 5000,
		});

		const content = await fs.readFile(storagePath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return migrateToV4(parsed);
	} catch (error) {
		log.warn("Failed to read locked accounts file, reading directly", { error: String(error) });
		try {
			const content = await fs.readFile(storagePath, "utf-8");
			const parsed = JSON.parse(content) as Record<string, unknown>;
			return migrateToV4(parsed);
		} catch {
			return { version: 4, activeIndex: 0, accounts: [] };
		}
	} finally {
		if (release) {
			await release().catch(() => {});
		}
	}
}

export function deduplicateAccountsByEmail<
	T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
	const emailToNewestIndex = new Map<string, number>();
	const indicesToKeep = new Set<number>();

	for (let i = 0; i < accounts.length; i++) {
		const acc = accounts[i];
		if (!acc) continue;

		if (!acc.email) {
			indicesToKeep.add(i);
			continue;
		}

		const existingIndex = emailToNewestIndex.get(acc.email);
		if (existingIndex === undefined) {
			emailToNewestIndex.set(acc.email, i);
			continue;
		}

		const existing = accounts[existingIndex];
		if (!existing) {
			emailToNewestIndex.set(acc.email, i);
			continue;
		}

		const currLastUsed = acc.lastUsed || 0;
		const existLastUsed = existing.lastUsed || 0;
		const currAddedAt = acc.addedAt || 0;
		const existAddedAt = existing.addedAt || 0;

		const isNewer =
			currLastUsed > existLastUsed ||
			(currLastUsed === existLastUsed && currAddedAt > existAddedAt);

		if (isNewer) {
			emailToNewestIndex.set(acc.email, i);
		}
	}

	for (const idx of emailToNewestIndex.values()) {
		indicesToKeep.add(idx);
	}

	const result: T[] = [];
	for (let i = 0; i < accounts.length; i++) {
		if (indicesToKeep.has(i)) {
			const acc = accounts[i];
			if (acc) result.push(acc);
		}
	}
	return result;
}

export function mergeAccountStorage(
	existing: AccountStorageV4,
	incoming: AccountStorageV4,
): AccountStorageV4 {
	const accountMap = new Map<string, StoredAccountV4>();

	for (const acc of existing.accounts) {
		if (acc.refreshToken) {
			accountMap.set(acc.refreshToken, acc);
		}
	}

	for (const acc of incoming.accounts) {
		if (acc.refreshToken) {
			const existingAcc = accountMap.get(acc.refreshToken);
			if (existingAcc) {
				const incomingLimits = acc.rateLimitResetTimes;
				const mergedLimits =
					incomingLimits === undefined
						? existingAcc.rateLimitResetTimes
						: Object.keys(incomingLimits).length === 0
							? {}
							: { ...existingAcc.rateLimitResetTimes, ...incomingLimits };
				accountMap.set(acc.refreshToken, {
					...existingAcc,
					...acc,
					projectId: existingAcc.projectId ?? acc.projectId,
					managedProjectId: existingAcc.managedProjectId ?? acc.managedProjectId,
					rateLimitResetTimes: mergedLimits,
					lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
				});
			} else {
				accountMap.set(acc.refreshToken, acc);
			}
		}
	}

	return {
		version: 4,
		accounts: Array.from(accountMap.values()),
		activeIndex: incoming.activeIndex,
	};
}

export async function saveAccountsReplace(storage: AccountStorageV4): Promise<void> {
	const storagePath = getStoragePath();
	const configDir = getAgentDir();
	mkdirSync(configDir, { recursive: true });
	ensureGitignore(configDir);

	const payload: AccountStorageV4 = {
		version: 4,
		activeIndex: storage.activeIndex,
		accounts: deduplicateAccountsByEmail(storage.accounts),
	};

	let release: (() => Promise<void>) | null = null;
	try {
		if (existsSync(storagePath)) {
			release = await lockfile.lock(storagePath, {
				retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
				stale: 5000,
			});
		}

		const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
		await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), {
			mode: 0o600,
			encoding: "utf-8",
		});
		await fs.rename(tempPath, storagePath);
	} catch (error) {
		try {
			await fs.unlink(`${storagePath}.tmp`);
		} catch {}
		throw error;
	} finally {
		if (release) {
			await release().catch(() => {});
		}
	}
}

export async function saveAccounts(storage: AccountStorageV4): Promise<void> {
	const storagePath = getStoragePath();
	const configDir = getAgentDir();
	mkdirSync(configDir, { recursive: true });
	ensureGitignore(configDir);

	let release: (() => Promise<void>) | null = null;
	try {
		if (existsSync(storagePath)) {
			release = await lockfile.lock(storagePath, {
				retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
				stale: 5000,
			});
		}

		let current: AccountStorageV4 = { version: 4, activeIndex: 0, accounts: [] };
		if (existsSync(storagePath)) {
			try {
				const content = await fs.readFile(storagePath, "utf-8");
				current = migrateToV4(JSON.parse(content));
			} catch {}
		}

		const merged = mergeAccountStorage(current, storage);
		merged.accounts = deduplicateAccountsByEmail(merged.accounts);

		const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
		await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), {
			mode: 0o600,
			encoding: "utf-8",
		});
		await fs.rename(tempPath, storagePath);
	} catch (error) {
		throw error;
	} finally {
		if (release) {
			await release().catch(() => {});
		}
	}
}

export async function clearAccounts(): Promise<void> {
	const storagePath = getStoragePath();
	if (existsSync(storagePath)) {
		await fs.unlink(storagePath).catch(() => {});
	}
}

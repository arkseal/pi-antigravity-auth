/**
 * Proactive Token Refresh Queue
 * Ported from opencode-antigravity-auth-updated/src/plugin/refresh-queue.ts
 */
import type { AccountManager, ManagedAccount } from "./accounts.js";
import { createLogger } from "./logger.js";

const log = createLogger("refresh-queue");

export interface ProactiveRefreshConfig {
	enabled: boolean;
	bufferSeconds: number;
	checkIntervalSeconds: number;
}

export const DEFAULT_PROACTIVE_REFRESH_CONFIG: ProactiveRefreshConfig = {
	enabled: true,
	bufferSeconds: 1800, // 30 minutes
	checkIntervalSeconds: 300, // 5 minutes
};

export class ProactiveRefreshQueue {
	private readonly config: ProactiveRefreshConfig;
	private accountManager: AccountManager | null = null;
	private intervalHandle: NodeJS.Timeout | null = null;
	private isRunningState = false;
	private isRefreshing = false;

	constructor(config?: Partial<ProactiveRefreshConfig>) {
		this.config = {
			...DEFAULT_PROACTIVE_REFRESH_CONFIG,
			...config,
		};
	}

	setAccountManager(manager: AccountManager): void {
		this.accountManager = manager;
	}

	needsRefresh(account: ManagedAccount): boolean {
		if (!account.expires) return false;
		const now = Date.now();
		const bufferMs = this.config.bufferSeconds * 1000;
		return account.expires <= now + bufferMs;
	}

	isExpired(account: ManagedAccount): boolean {
		if (!account.expires) return false;
		return account.expires <= Date.now();
	}

	getAccountsNeedingRefresh(): ManagedAccount[] {
		if (!this.accountManager) return [];
		return this.accountManager.getAccounts().filter((account) => {
			if (!account.enabled) return false;
			if (this.isExpired(account)) return false;
			return this.needsRefresh(account);
		});
	}

	private async runRefreshCheck(): Promise<void> {
		if (this.isRefreshing || !this.accountManager) return;
		this.isRefreshing = true;

		try {
			const accountsToRefresh = this.getAccountsNeedingRefresh();
			if (accountsToRefresh.length === 0) return;

			log.debug("Proactive refresh: accounts needing refresh", { count: accountsToRefresh.length });

			for (const account of accountsToRefresh) {
				if (!this.isRunningState) break;
				try {
					await this.accountManager.getAccessTokenForAccount(account);
				} catch (error) {
					log.warn("Failed to proactively refresh account", {
						accountIndex: account.index,
						error: String(error),
					});
				}
			}
		} finally {
			this.isRefreshing = false;
		}
	}

	start(): void {
		if (this.isRunningState) return;
		if (!this.config.enabled) return;

		this.isRunningState = true;
		const intervalMs = this.config.checkIntervalSeconds * 1000;

		const initialTimer = setTimeout(() => {
			if (this.isRunningState) {
				this.runRefreshCheck().catch(() => {});
			}
		}, 5000);
		initialTimer.unref();

		this.intervalHandle = setInterval(() => {
			this.runRefreshCheck().catch(() => {});
		}, intervalMs);
		this.intervalHandle.unref();
	}

	stop(): void {
		if (!this.isRunningState) return;
		this.isRunningState = false;
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
	}

	isRunning(): boolean {
		return this.isRunningState;
	}
}

export function createProactiveRefreshQueue(
	config?: Partial<ProactiveRefreshConfig>,
): ProactiveRefreshQueue {
	return new ProactiveRefreshQueue(config);
}

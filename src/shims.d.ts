declare module "proper-lockfile" {
	export interface LockOptions {
		stale?: number;
		update?: number;
		retries?: number | { retries?: number; minTimeout?: number; maxTimeout?: number; factor?: number };
		realpath?: boolean;
		fs?: unknown;
		onCompromised?: (err: Error) => void;
		lockfilePath?: string;
	}

	export interface CheckOptions {
		stale?: number;
		realpath?: boolean;
		fs?: unknown;
		lockfilePath?: string;
	}

	export interface UnlockOptions {
		realpath?: boolean;
		fs?: unknown;
		lockfilePath?: string;
	}

	export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
	export function unlock(file: string, options?: UnlockOptions): Promise<void>;
	export function check(file: string, options?: CheckOptions): Promise<boolean>;
	export function lockSync(file: string, options?: LockOptions): () => void;
	export function unlockSync(file: string, options?: UnlockOptions): void;
	export function checkSync(file: string, options?: CheckOptions): boolean;

	const defaultExport: {
		lock: typeof lock;
		unlock: typeof unlock;
		check: typeof check;
		lockSync: typeof lockSync;
		unlockSync: typeof unlockSync;
		checkSync: typeof checkSync;
	};
	export default defaultExport;
}

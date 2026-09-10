/**
 * Custom error types for Antigravity integration.
 */

export class EmptyResponseError extends Error {
	readonly provider: string;
	readonly model: string;
	readonly attempts: number;

	constructor(provider: string, model: string, attempts: number, message?: string) {
		super(
			message ??
				`The model returned an empty response after ${attempts} attempts. ` +
				`This may indicate a temporary service issue. Please try again.`,
		);
		this.name = "EmptyResponseError";
		this.provider = provider;
		this.model = model;
		this.attempts = attempts;
	}
}

export class ToolIdMismatchError extends Error {
	readonly expectedIds: string[];
	readonly foundIds: string[];

	constructor(expectedIds: string[], foundIds: string[], message?: string) {
		super(
			message ??
				`Tool ID mismatch: expected [${expectedIds.join(", ")}] but found [${foundIds.join(", ")}]`,
		);
		this.name = "ToolIdMismatchError";
		this.expectedIds = expectedIds;
		this.foundIds = foundIds;
	}
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

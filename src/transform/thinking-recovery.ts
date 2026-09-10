/**
 * Thinking Recovery Module.
 * Ported from opencode-antigravity-auth-updated/src/plugin/thinking-recovery.ts
 *
 * Minimal implementation for recovering from corrupted thinking state.
 * When Claude's conversation history gets corrupted (thinking blocks stripped/malformed),
 * this module provides a "last resort" recovery by closing the current turn and starting fresh.
 *
 * Philosophy: "Let it crash and start again" - Instead of trying to fix corrupted state,
 * we abandon the corrupted turn and let Claude generate fresh thinking.
 */

export interface ConversationState {
	/** True if we're in an incomplete tool use loop (ends with functionResponse) */
	inToolLoop: boolean;
	/** Index of first model message in current turn */
	turnStartIdx: number;
	/** Whether the TURN started with thinking */
	turnHasThinking: boolean;
	/** Index of last model message */
	lastModelIdx: number;
	/** Whether last model msg has thinking */
	lastModelHasThinking: boolean;
	/** Whether last model msg has tool calls */
	lastModelHasToolCalls: boolean;
}

function isThinkingPart(part: unknown): boolean {
	if (!part || typeof part !== "object") return false;
	const p = part as Record<string, unknown>;
	return p.thought === true || p.type === "thinking" || p.type === "redacted_thinking";
}

function isFunctionResponsePart(part: unknown): boolean {
	return !!part && typeof part === "object" && "functionResponse" in (part as Record<string, unknown>);
}

function isFunctionCallPart(part: unknown): boolean {
	return !!part && typeof part === "object" && "functionCall" in (part as Record<string, unknown>);
}

function isToolResultMessage(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const m = msg as { role?: string; parts?: unknown[] };
	if (m.role !== "user") return false;
	const parts = m.parts || [];
	return parts.some(isFunctionResponsePart);
}

function messageHasThinking(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const m = msg as { parts?: unknown[]; content?: unknown[] };
	if (Array.isArray(m.parts)) {
		return m.parts.some(isThinkingPart);
	}
	if (Array.isArray(m.content)) {
		return m.content.some((b: unknown) => {
			const block = b as { type?: string };
			return block?.type === "thinking" || block?.type === "redacted_thinking";
		});
	}
	return false;
}

function messageHasToolCalls(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const m = msg as { parts?: unknown[]; content?: unknown[] };
	if (Array.isArray(m.parts)) {
		return m.parts.some(isFunctionCallPart);
	}
	if (Array.isArray(m.content)) {
		return m.content.some((b: unknown) => (b as { type?: string })?.type === "tool_use");
	}
	return false;
}

export function analyzeConversationState(contents: unknown[]): ConversationState {
	const state: ConversationState = {
		inToolLoop: false,
		turnStartIdx: -1,
		turnHasThinking: false,
		lastModelIdx: -1,
		lastModelHasThinking: false,
		lastModelHasToolCalls: false,
	};

	if (!Array.isArray(contents) || contents.length === 0) {
		return state;
	}

	let lastRealUserIdx = -1;
	for (let i = 0; i < contents.length; i++) {
		const msg = contents[i];
		const role = (msg as { role?: string })?.role;
		if (role === "user" && !isToolResultMessage(msg)) {
			lastRealUserIdx = i;
		}
	}

	for (let i = 0; i < contents.length; i++) {
		const msg = contents[i];
		const role = (msg as { role?: string })?.role;

		if (role === "model" || role === "assistant") {
			const hasThinking = messageHasThinking(msg);
			const hasToolCalls = messageHasToolCalls(msg);

			if (i > lastRealUserIdx && state.turnStartIdx === -1) {
				state.turnStartIdx = i;
				state.turnHasThinking = hasThinking;
			}

			state.lastModelIdx = i;
			state.lastModelHasToolCalls = hasToolCalls;
			state.lastModelHasThinking = hasThinking;
		}
	}

	if (contents.length > 0) {
		const lastMsg = contents[contents.length - 1];
		if (isToolResultMessage(lastMsg)) {
			state.inToolLoop = true;
		}
	}

	return state;
}

export function stripAllThinkingBlocks(contents: unknown[]): unknown[] {
	return contents.map((content) => {
		if (!content || typeof content !== "object") return content;
		const c = content as { parts?: unknown[]; content?: unknown[] };

		if (Array.isArray(c.parts)) {
			const filteredParts = c.parts.filter((part) => !isThinkingPart(part));
			if (filteredParts.length === 0 && c.parts.length > 0) {
				return content;
			}
			return { ...c, parts: filteredParts };
		}

		if (Array.isArray(c.content)) {
			const filteredContent = c.content.filter((block: unknown) => {
				const b = block as { type?: string };
				return b?.type !== "thinking" && b?.type !== "redacted_thinking";
			});
			if (filteredContent.length === 0 && c.content.length > 0) {
				return content;
			}
			return { ...c, content: filteredContent };
		}

		return content;
	});
}

function countTrailingToolResults(contents: unknown[]): number {
	let count = 0;
	for (let i = contents.length - 1; i >= 0; i--) {
		const msg = contents[i] as { role?: string; parts?: unknown[] } | undefined;
		if (msg?.role === "user") {
			const parts = msg.parts || [];
			const functionResponses = parts.filter(isFunctionResponsePart);
			if (functionResponses.length > 0) {
				count += functionResponses.length;
			} else {
				break;
			}
		} else if (msg?.role === "model" || msg?.role === "assistant") {
			break;
		}
	}
	return count;
}

export function closeToolLoopForThinking(contents: unknown[]): unknown[] {
	const strippedContents = stripAllThinkingBlocks(contents);
	const toolResultCount = countTrailingToolResults(strippedContents);

	let syntheticModelContent: string;
	if (toolResultCount === 0) {
		syntheticModelContent = "[Processing previous context.]";
	} else if (toolResultCount === 1) {
		syntheticModelContent = "[Tool execution completed.]";
	} else {
		syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
	}

	const syntheticModel = {
		role: "model",
		parts: [{ text: syntheticModelContent }],
	};

	const syntheticUser = {
		role: "user",
		parts: [{ text: "[Continue]" }],
	};

	return [...strippedContents, syntheticModel, syntheticUser];
}

export function needsThinkingRecovery(state: ConversationState): boolean {
	return state.inToolLoop && !state.turnHasThinking;
}

export function looksLikeCompactedThinkingTurn(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const parts = (msg as { parts?: unknown[] }).parts || [];
	if (parts.length === 0) return false;

	const hasFunctionCall = parts.some(
		(p: unknown) => p && typeof p === "object" && "functionCall" in (p as Record<string, unknown>),
	);
	if (!hasFunctionCall) return false;

	const hasThinking = parts.some(
		(p: unknown) =>
			p &&
			typeof p === "object" &&
			((p as Record<string, unknown>).thought === true ||
				(p as Record<string, unknown>).type === "thinking" ||
				(p as Record<string, unknown>).type === "redacted_thinking"),
	);
	if (hasThinking) return false;

	const firstFuncIdx = parts.findIndex(
		(fp: unknown) => fp && typeof fp === "object" && "functionCall" in (fp as Record<string, unknown>),
	);
	const hasTextBeforeFunctionCall = parts.some((p: unknown, idx: number) => {
		if (!p || typeof p !== "object") return false;
		if (idx >= firstFuncIdx) return false;
		const obj = p as Record<string, unknown>;
		return typeof obj.text === "string" && obj.text.trim().length > 0 && !obj.thought;
	});

	return !hasTextBeforeFunctionCall;
}

export function hasPossibleCompactedThinking(contents: unknown[], turnStartIdx: number): boolean {
	if (!Array.isArray(contents) || turnStartIdx < 0) return false;
	for (let i = turnStartIdx; i < contents.length; i++) {
		const msg = contents[i] as { role?: string } | undefined;
		if (msg?.role === "model" && looksLikeCompactedThinkingTurn(msg)) {
			return true;
		}
	}
	return false;
}

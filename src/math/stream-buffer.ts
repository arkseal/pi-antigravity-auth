import { latexToUnicode } from "./latex-to-unicode.js";

const MAX_PENDING_MATH_CHARS = 300;

export class MathStreamBuffer {
	private pending = "";

	/**
	 * Appends incoming chunk, transforms completed math expressions,
	 * and retains unclosed expressions in the buffer.
	 */
	process(chunk: string): string {
		const text = this.pending + chunk;
		this.pending = "";

		if (!text.includes("$")) {
			return text;
		}

		if (text.length > MAX_PENDING_MATH_CHARS || text.includes("\n\n")) {
			return latexToUnicode(text);
		}

		let inCodeSpan = false;
		let inDisplayMath = false;
		let inInlineMath = false;
		let unclosedDelimiterIndex = -1;

		let i = 0;
		while (i < text.length) {
			if (text[i] === "`") {
				inCodeSpan = !inCodeSpan;
				i++;
				continue;
			}

			if (inCodeSpan) {
				i++;
				continue;
			}

			if (text[i] === "\\" && text[i + 1] === "$") {
				i += 2;
				continue;
			}

			if (text[i] === "$" && text[i + 1] === "$") {
				if (inDisplayMath) {
					inDisplayMath = false;
					unclosedDelimiterIndex = -1;
					i += 2;
					continue;
				}
				if (!inInlineMath) {
					inDisplayMath = true;
					unclosedDelimiterIndex = i;
					i += 2;
					continue;
				}
			}

			if (text[i] === "$" && !inDisplayMath) {
				if (inInlineMath) {
					if (i > 0 && text[i - 1] !== " ") {
						inInlineMath = false;
						unclosedDelimiterIndex = -1;
					}
					i++;
					continue;
				}
				const nextChar = text[i + 1];
				if (nextChar !== " ") {
					inInlineMath = true;
					unclosedDelimiterIndex = i;
				}
				i++;
				continue;
			}

			i++;
		}

		if ((inInlineMath || inDisplayMath) && unclosedDelimiterIndex !== -1) {
			const readyPart = text.slice(0, unclosedDelimiterIndex);
			this.pending = text.slice(unclosedDelimiterIndex);
			return latexToUnicode(readyPart);
		}

		return latexToUnicode(text);
	}

	flush(): string {
		if (!this.pending) return "";
		const remaining = this.pending;
		this.pending = "";
		return latexToUnicode(remaining);
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}
}

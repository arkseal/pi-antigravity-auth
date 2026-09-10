const SYMBOL_MAP: Record<string, string> = {
	// Arrows
	"\\to": "→",
	"\\rightarrow": "→",
	"\\longrightarrow": "→",
	"\\gets": "←",
	"\\leftarrow": "←",
	"\\longleftarrow": "←",
	"\\Rightarrow": "⇒",
	"\\implies": "⇒",
	"\\Longrightarrow": "⇒",
	"\\Leftarrow": "⇐",
	"\\impliedby": "⇐",
	"\\leftrightarrow": "⇔",
	"\\iff": "⇔",
	"\\Longleftrightarrow": "⇔",
	"\\uparrow": "↑",
	"\\downarrow": "↓",
	"\\updownarrow": "↕",
	"\\mapsto": "↦",

	// Comparisons and Relations
	"\\approx": "≈",
	"\\neq": "≠",
	"\\ne": "≠",
	"\\le": "≤",
	"\\leq": "≤",
	"\\ge": "≥",
	"\\geq": "≥",
	"\\equiv": "≡",
	"\\sim": "∼",
	"\\propto": "∝",
	"\\pm": "±",
	"\\mp": "∓",
	"\\times": "×",
	"\\cdot": "·",
	"\\div": "÷",

	// Set and Logic
	"\\in": "∈",
	"\\notin": "∉",
	"\\ni": "∋",
	"\\owns": "∋",
	"\\subset": "⊂",
	"\\supset": "⊃",
	"\\subseteq": "⊆",
	"\\supseteq": "⊇",
	"\\cup": "∪",
	"\\cap": "∩",
	"\\setminus": "\\",
	"\\emptyset": "∅",
	"\\varnothing": "∅",
	"\\forall": "∀",
	"\\exists": "∃",
	"\\nexists": "∄",
	"\\infty": "∞",
	"\\partial": "∂",
	"\\nabla": "∇",
	"\\sum": "∑",
	"\\prod": "∏",
	"\\int": "∫",
	"\\circ": "∘",
	"\\bullet": "•",
	"\\star": "⋆",
	"\\angle": "∠",

	// Greek Lowercase
	"\\alpha": "α",
	"\\beta": "β",
	"\\gamma": "γ",
	"\\delta": "δ",
	"\\epsilon": "ε",
	"\\varepsilon": "ε",
	"\\zeta": "ζ",
	"\\eta": "η",
	"\\theta": "θ",
	"\\iota": "ι",
	"\\kappa": "κ",
	"\\lambda": "λ",
	"\\mu": "μ",
	"\\nu": "ν",
	"\\xi": "ξ",
	"\\pi": "π",
	"\\rho": "ρ",
	"\\sigma": "σ",
	"\\tau": "τ",
	"\\upsilon": "υ",
	"\\phi": "φ",
	"\\varphi": "φ",
	"\\chi": "χ",
	"\\psi": "ψ",
	"\\omega": "ω",

	// Greek Uppercase
	"\\Gamma": "Γ",
	"\\Delta": "Δ",
	"\\Theta": "Θ",
	"\\Lambda": "Λ",
	"\\Xi": "Ξ",
	"\\Pi": "Π",
	"\\Sigma": "Σ",
	"\\Upsilon": "Υ",
	"\\Phi": "Φ",
	"\\Psi": "Ψ",
	"\\Omega": "Ω",
};

const SUPERSCRIPT_MAP: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
	x: "ˣ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

function toSuperscript(str: string): string {
	return str
		.split("")
		.map((c) => SUPERSCRIPT_MAP[c] ?? c)
		.join("");
}

function toSubscript(str: string): string {
	return str
		.split("")
		.map((c) => SUBSCRIPT_MAP[c] ?? c)
		.join("");
}

/**
 * Transforms an inner LaTeX expression (content inside $...$ or $$...$$) to Unicode.
 */
export function transformMathExpression(expr: string): string {
	let res = expr;

	// Replace styles: \text{foo}, \mathrm{foo}, \operatorname{foo}, \mathbf{foo}
	res = res.replace(/\\(?:text|mathrm|operatorname|mathbf|mathit)\{([^}]+)\}/g, "$1");

	// Replace complexity \mathcal{O} or \mathcal{o}
	res = res.replace(/\\mathcal\{([A-Za-z])\}/g, "$1");

	// Roots: \sqrt[3]{...} -> ∛(...) and \sqrt{...} -> √(...)
	res = res.replace(/\\sqrt\[3\]\{([^}]+)\}/g, "∛($1)");
	res = res.replace(/\\sqrt\{([^}]+)\}/g, "√($1)");

	// Fractions: \frac{num}{den}
	res = res.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, (_match, num: string, den: string) => {
		const cleanNum = num.length > 1 && /[+\-*\/]/.test(num) ? `(${num.trim()})` : num.trim();
		const cleanDen = den.length > 1 && /[+\-*\/]/.test(den) ? `(${den.trim()})` : den.trim();
		return `${cleanNum}/${cleanDen}`;
	});

	// Superscripts: ^{...} or ^c
	res = res.replace(/\^{([^}]+)\}/g, (_match, inner) => toSuperscript(inner));
	res = res.replace(/\^([0-9+\-()nix])/g, (_match, c) => toSuperscript(c));

	// Subscripts: _{...} or _c
	res = res.replace(/_{([^}]+)\}/g, (_match, inner) => toSubscript(inner));
	res = res.replace(/_([0-9+\-()aehijklmnoprstuvx])/g, (_match, c) => toSubscript(c));

	// Replace mapped symbols with word boundary / delimiter awareness
	for (const [cmd, symbol] of Object.entries(SYMBOL_MAP)) {
		const escaped = cmd.replace(/\\/g, "\\\\");
		const regex = new RegExp(`${escaped}(?![a-zA-Z])`, "g");
		res = res.replace(regex, symbol);
	}

	return res.trim();
}

function hasMathIndicators(expr: string): boolean {
	if (/\\\w+/.test(expr)) return true;
	if (/[\^_{}]/.test(expr)) return true;
	if (/[a-zA-Z0-9]\s*[=+\-*/<>≤≥≠≈]\s*[a-zA-Z0-9]/.test(expr)) return true;
	return false;
}

function isFalsePositiveDollar(text: string, index: number, inner: string): boolean {
	if (index > 0 && text[index - 1] === "\\") return true;

	const nextChar = text[index + 1];
	if (!nextChar) return true;

	if (nextChar === "{") return true;

	if (inner.startsWith(" ") || inner.endsWith(" ")) return true;

	if (/[0-9]/.test(nextChar) && !hasMathIndicators(inner)) return true;

	if (/^[A-Z_]{2,}$/.test(inner)) return true;

	const closingDollarIndex = index + 1 + inner.length;
	const afterClosing = text[closingDollarIndex + 1];
	if (afterClosing && /[0-9]/.test(afterClosing) && !hasMathIndicators(inner)) return true;

	return false;
}

/**
 * Transforms LaTeX math expressions in markdown text to Unicode.
 * Code blocks and inline code are protected.
 */
export function latexToUnicode(text: string): string {
	if (!text || !text.includes("$")) {
		return text;
	}

	const tokens: Array<{ type: "code" | "text"; content: string }> = [];
	let currentIndex = 0;

	const codeRegex = /(```[\s\S]*?```|`[^`\n]*`)/g;
	let match: RegExpExecArray | null;

	while ((match = codeRegex.exec(text)) !== null) {
		if (match.index > currentIndex) {
			tokens.push({ type: "text", content: text.slice(currentIndex, match.index) });
		}
		tokens.push({ type: "code", content: match[0] });
		currentIndex = match.index + match[0].length;
	}

	if (currentIndex < text.length) {
		tokens.push({ type: "text", content: text.slice(currentIndex) });
	}

	return tokens
		.map((token) => {
			if (token.type === "code") {
				return token.content;
			}

			let content = token.content;

			// 1. Transform display math: $$ ... $$
			content = content.replace(/\$\$([\s\S]+?)\$\$/g, (_match, inner) => {
				const transformed = transformMathExpression(inner);
				return `\n${transformed}\n`;
			});

			// 2. Transform inline math: $ ... $
			content = content.replace(/\$([^\$\n]+?)\$/g, (fullMatch, inner: string, offset: number) => {
				if (isFalsePositiveDollar(content, offset, inner)) {
					return fullMatch;
				}
				return transformMathExpression(inner);
			});

			return content;
		})
		.join("");
}

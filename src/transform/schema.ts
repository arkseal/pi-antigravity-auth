/**
 * JSON Schema Cleaning for Antigravity & Vertex AI Claude.
 *
 * Normalizes rich JSON Schema / TypeBox definitions into schemas compatible
 * with Antigravity (Google Cloud Code Assist) and Anthropic Vertex Claude:
 *   - Flattens unions of literals (`Type.Union([Type.Literal(...)])`) into `{ type: "string", enum: [...] }`
 *   - Converts `const` values into `enum` arrays
 *   - Merges `allOf` and flattens non-enum `anyOf` / `oneOf` unions
 *   - Moves unsupported validation constraints to description hints
 *   - Removes schema keywords rejected by Draft 2020-12 / OpenAPI subset ($schema, $defs, etc.)
 *   - Injects `_placeholder` parameter for empty object schemas
 */

import {
	EMPTY_SCHEMA_PLACEHOLDER_NAME,
	EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
} from "../constants.js";

const UNSUPPORTED_CONSTRAINTS = [
	"minLength",
	"maxLength",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"pattern",
	"minItems",
	"maxItems",
	"format",
	"default",
	"examples",
] as const;

const UNSUPPORTED_KEYWORDS = [
	...UNSUPPORTED_CONSTRAINTS,
	"$schema",
	"$defs",
	"definitions",
	"const",
	"$ref",
	"additionalProperties",
	"propertyNames",
	"title",
	"$id",
	"$comment",
] as const;

function appendDescriptionHint(schema: Record<string, unknown>, hint: string): Record<string, unknown> {
	if (!schema || typeof schema !== "object") return schema;
	const existing = typeof schema.description === "string" ? schema.description : "";
	const newDescription = existing ? `${existing} (${hint})` : hint;
	return { ...schema, description: newDescription };
}

function convertRefsToHints(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(convertRefsToHints);

	const obj = schema as Record<string, unknown>;
	if (typeof obj.$ref === "string") {
		const refVal = obj.$ref;
		const defName = refVal.includes("/") ? refVal.split("/").pop() : refVal;
		const hint = `See: ${defName}`;
		const existingDesc = typeof obj.description === "string" ? obj.description : "";
		return { type: "object", description: existingDesc ? `${existingDesc} (${hint})` : hint };
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = convertRefsToHints(value);
	}
	return result;
}

function convertConstToEnum(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(convertConstToEnum);

	const obj = schema as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === "const" && !obj.enum) {
			result.enum = [value];
		} else {
			result[key] = convertConstToEnum(value);
		}
	}
	return result;
}

function addEnumHints(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(addEnumHints);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (Array.isArray(result.enum) && result.enum.length > 1 && result.enum.length <= 10) {
		const vals = (result.enum as unknown[]).map((v) => String(v)).join(", ");
		result = appendDescriptionHint(result, `Allowed: ${vals}`);
	}

	for (const [key, value] of Object.entries(result)) {
		if (key !== "enum" && typeof value === "object" && value !== null) {
			result[key] = addEnumHints(value);
		}
	}
	return result;
}

function addAdditionalPropertiesHints(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(addAdditionalPropertiesHints);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (result.additionalProperties === false) {
		result = appendDescriptionHint(result, "No extra properties allowed");
	}

	for (const [key, value] of Object.entries(result)) {
		if (key !== "additionalProperties" && typeof value === "object" && value !== null) {
			result[key] = addAdditionalPropertiesHints(value);
		}
	}
	return result;
}

function moveConstraintsToDescription(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(moveConstraintsToDescription);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	for (const constraint of UNSUPPORTED_CONSTRAINTS) {
		if (result[constraint] !== undefined && typeof result[constraint] !== "object") {
			result = appendDescriptionHint(result, `${constraint}: ${result[constraint]}`);
		}
	}

	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "object" && value !== null) {
			result[key] = moveConstraintsToDescription(value);
		}
	}
	return result;
}

function mergeAllOf(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(mergeAllOf);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (Array.isArray(result.allOf) && result.allOf.length > 0) {
		const mergedProps: Record<string, unknown> = {};
		const mergedRequired: string[] = [];
		for (const sub of result.allOf as unknown[]) {
			if (sub && typeof sub === "object") {
				const subRec = sub as Record<string, unknown>;
				if (subRec.properties && typeof subRec.properties === "object") {
					Object.assign(mergedProps, subRec.properties);
				}
				if (Array.isArray(subRec.required)) {
					mergedRequired.push(...(subRec.required as string[]));
				}
			}
		}
		result.properties = {
			...((result.properties as Record<string, unknown>) || {}),
			...mergedProps,
		};
		if (mergedRequired.length > 0) {
			const existing = Array.isArray(result.required) ? (result.required as string[]) : [];
			result.required = Array.from(new Set([...existing, ...mergedRequired]));
		}
		delete result.allOf;
	}

	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "object" && value !== null) {
			result[key] = mergeAllOf(value);
		}
	}
	return result;
}

function tryMergeEnumFromUnion(options: unknown[]): string[] | null {
	if (!Array.isArray(options) || options.length === 0) return null;

	const enumValues: string[] = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return null;
		const opt = option as Record<string, unknown>;

		if (opt.const !== undefined) {
			enumValues.push(String(opt.const));
			continue;
		}

		if (Array.isArray(opt.enum) && opt.enum.length === 1) {
			enumValues.push(String(opt.enum[0]));
			continue;
		}

		if (Array.isArray(opt.enum) && opt.enum.length > 0) {
			for (const val of opt.enum) enumValues.push(String(val));
			continue;
		}

		// Complex structure means it's not a pure enum union
		if (opt.properties || opt.items || opt.anyOf || opt.oneOf || opt.allOf) {
			return null;
		}

		if (opt.type && !opt.const && !opt.enum) {
			return null;
		}
	}

	return enumValues.length > 0 ? enumValues : null;
}

function scoreSchemaOption(schema: unknown): { score: number; typeName: string } {
	if (!schema || typeof schema !== "object") return { score: 0, typeName: "unknown" };
	const opt = schema as Record<string, unknown>;
	const type = typeof opt.type === "string" ? opt.type : undefined;

	if (type === "object" || opt.properties) return { score: 3, typeName: "object" };
	if (type === "array" || opt.items) return { score: 2, typeName: "array" };
	if (type && type !== "null") return { score: 1, typeName: type };
	return { score: 0, typeName: type || "null" };
}

function flattenAnyOfOneOf(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(flattenAnyOfOneOf);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };

	for (const unionKey of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(result[unionKey]) && (result[unionKey] as unknown[]).length > 0) {
			const options = result[unionKey] as unknown[];
			const parentDesc = typeof result.description === "string" ? result.description : "";

			// Check for enum union pattern (e.g. Type.Union([Type.Literal(...)]))
			const mergedEnum = tryMergeEnumFromUnion(options);
			if (mergedEnum !== null) {
				const { [unionKey]: _, ...rest } = result;
				result = { ...rest, type: "string", enum: mergedEnum };
				if (parentDesc) result.description = parentDesc;
				continue;
			}

			// Non-enum union: select best candidate
			let bestIdx = 0;
			let bestScore = -1;
			const allTypes: string[] = [];
			for (let i = 0; i < options.length; i++) {
				const { score, typeName } = scoreSchemaOption(options[i]);
				if (typeName) allTypes.push(typeName);
				if (score > bestScore) {
					bestScore = score;
					bestIdx = i;
				}
			}

			let selected = (flattenAnyOfOneOf(options[bestIdx]) as Record<string, unknown>) || {
				type: "string",
			};
			if (parentDesc) {
				const childDesc = typeof selected.description === "string" ? selected.description : "";
				selected = {
					...selected,
					description:
						childDesc && childDesc !== parentDesc ? `${parentDesc} (${childDesc})` : parentDesc,
				};
			}

			if (allTypes.length > 1) {
				const unique = Array.from(new Set(allTypes));
				selected = appendDescriptionHint(selected, `Accepts: ${unique.join(" | ")}`);
			}

			const { [unionKey]: _, description: __, ...rest } = result;
			result = { ...rest, ...selected };
		}
	}

	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "object" && value !== null) {
			result[key] = flattenAnyOfOneOf(value);
		}
	}
	return result;
}

function flattenTypeArrays(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(flattenTypeArrays);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (Array.isArray(result.type)) {
		const types = result.type as string[];
		const hasNull = types.includes("null");
		const nonNull = types.filter((t) => t !== "null" && t);
		result.type = nonNull.length > 0 ? nonNull[0] : "string";
		if (nonNull.length > 1) {
			result = appendDescriptionHint(result, `Accepts: ${nonNull.join(" | ")}`);
		}
		if (hasNull) {
			result = appendDescriptionHint(result, "nullable");
		}
	}

	if (result.properties && typeof result.properties === "object") {
		const newProps: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(result.properties as Record<string, unknown>)) {
			newProps[k] = flattenTypeArrays(v);
		}
		result.properties = newProps;
	}
	return result;
}

function removeUnsupportedKeywords(schema: unknown, insideProperties = false): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) {
		return schema.map((item) => removeUnsupportedKeywords(item, false));
	}

	const result: Record<string, unknown> = {};
	const obj = schema as Record<string, unknown>;

	for (const [key, value] of Object.entries(obj)) {
		if (!insideProperties && (UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
			continue;
		}

		if (typeof value === "object" && value !== null) {
			if (key === "properties") {
				const props: Record<string, unknown> = {};
				for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
					props[pk] = removeUnsupportedKeywords(pv, false);
				}
				result[key] = props;
			} else {
				result[key] = removeUnsupportedKeywords(value, false);
			}
		} else {
			result[key] = value;
		}
	}
	return result;
}

function cleanupRequiredFields(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(cleanupRequiredFields);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
		const props = result.properties as Record<string, unknown>;
		const valid = (result.required as string[]).filter((r) =>
			Object.prototype.hasOwnProperty.call(props, r),
		);
		if (valid.length === 0) {
			delete result.required;
		} else {
			result.required = valid;
		}
	}

	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "object" && value !== null) {
			result[key] = cleanupRequiredFields(value);
		}
	}
	return result;
}

function addEmptySchemaPlaceholder(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(addEmptySchemaPlaceholder);

	let result: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if (result.type === "object") {
		const hasProps =
			result.properties &&
			typeof result.properties === "object" &&
			Object.keys(result.properties as Record<string, unknown>).length > 0;

		if (!hasProps) {
			result.properties = {
				[EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
					type: "boolean",
					description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
				},
			};
			result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
		}
	}

	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "object" && value !== null) {
			result[key] = addEmptySchemaPlaceholder(value);
		}
	}
	return result;
}

/**
 * Cleans and transforms any JSON Schema into a compliant schema for Antigravity & Claude.
 */
export function cleanJSONSchemaForAntigravity(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object") {
		return (schema as Record<string, unknown>) ?? {};
	}

	let result: unknown = schema;
	result = convertRefsToHints(result);
	result = convertConstToEnum(result);
	result = addEnumHints(result);
	result = addAdditionalPropertiesHints(result);
	result = moveConstraintsToDescription(result);
	result = mergeAllOf(result);
	result = flattenAnyOfOneOf(result);
	result = flattenTypeArrays(result);
	result = removeUnsupportedKeywords(result);
	result = cleanupRequiredFields(result);
	result = addEmptySchemaPlaceholder(result);

	return result as Record<string, unknown>;
}

import { DEFAULTS, VALUE, type TrackerConfig } from "./config.js";

/**
 * Parse and check one report against the tracker config. A report is:
 *
 *   { "app": "my-app", "installId": "<uuid>", "version": "1.2.3",
 *     "rows": [ { "dimensions": { "feature": "export" }, "counts": { "uses": 3 } } ] }
 *
 * Every row must name every dimension of the app. A dimension value that isn't
 * in the app's list is stored as `other`, so an older Worker keeps accepting a
 * newer client. Counts the row leaves out are 0. Rows that share dimensions
 * after that are summed.
 */

export interface Row {
	/** Canonical JSON of the dimensions, keys sorted. */
	dims: string;
	counts: Record<string, number>;
}

export interface Report {
	app: string;
	installId: string;
	version: string;
	rows: Row[];
}

export type ParseResult = { ok: true; report: Report } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;

export function parseReport(config: TrackerConfig, body: Uint8Array): ParseResult {
	let input: unknown;
	try {
		input = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return fail("body is not JSON");
	}
	if (!isObject(input) || !sameKeys(input, ["app", "installId", "version", "rows"])) {
		return fail("a report has exactly the keys app, installId, version, rows");
	}
	const { app, installId, version, rows } = input;
	if (typeof app !== "string" || !Object.hasOwn(config.apps, app)) return fail("unknown app");
	const appConfig = config.apps[app]!;
	if (typeof installId !== "string" || !UUID.test(installId)) return fail("installId must be a lowercase UUID");
	if (typeof version !== "string" || !VERSION.test(version)) return fail("version must be MAJOR.MINOR.PATCH");
	const maxRows = appConfig.maxRows ?? DEFAULTS.maxRows;
	if (!Array.isArray(rows) || rows.length > maxRows) return fail(`rows must be an array of at most ${maxRows}`);

	const maxCount = appConfig.maxCount ?? DEFAULTS.maxCount;
	const dimensionNames = Object.keys(appConfig.dimensions).sort();
	const merged = new Map<string, Record<string, number>>();
	for (const [i, row] of rows.entries()) {
		if (!isObject(row) || !sameKeys(row, ["dimensions", "counts"])) return fail(`rows[${i}] has exactly the keys dimensions, counts`);
		const { dimensions, counts } = row;
		if (!isObject(dimensions) || !sameKeys(dimensions, dimensionNames)) {
			return fail(`rows[${i}].dimensions must have exactly ${dimensionNames.join(", ") || "no keys"}`);
		}
		const dims: Record<string, string> = {};
		for (const name of dimensionNames) {
			const value = dimensions[name];
			if (typeof value !== "string" || !VALUE.test(value)) return fail(`rows[${i}].dimensions.${name} must match ${VALUE}`);
			dims[name] = appConfig.dimensions[name]!.includes(value) ? value : "other";
		}
		if (!isObject(counts)) return fail(`rows[${i}].counts must be an object`);
		const totals: Record<string, number> = Object.fromEntries(appConfig.counts.map((name) => [name, 0]));
		for (const [name, value] of Object.entries(counts)) {
			if (!appConfig.counts.includes(name)) return fail(`rows[${i}].counts.${name} is not a count of ${app}`);
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maxCount) {
				return fail(`rows[${i}].counts.${name} must be an integer from 0 to ${maxCount}`);
			}
			totals[name] = value;
		}
		const key = JSON.stringify(dims);
		const existing = merged.get(key);
		if (!existing) merged.set(key, totals);
		else for (const name of appConfig.counts) existing[name] = Math.min(maxCount, existing[name]! + totals[name]!);
	}
	return { ok: true, report: { app, installId, version, rows: [...merged].map(([dims, counts]) => ({ dims, counts })) } };
}

function fail(error: string): ParseResult {
	return { ok: false, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

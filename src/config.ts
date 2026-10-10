/**
 * A tracker deployment serves one or more apps. Each app declares its
 * dimensions, with the values each one may take, and the names of its counts.
 * The Worker rejects a report that names anything else, so a report can only
 * carry values the app's maintainers listed.
 */

export interface AppConfig {
	/** Each dimension and the values it may take. A value outside the list is stored as `other`. */
	dimensions: Record<string, string[]>;
	/** The count names a row may carry. A missing count is stored as 0. */
	counts: string[];
	/** Most rows one report may carry. Default 100. */
	maxRows?: number;
	/** Largest value a count may take. Default 10,000,000. */
	maxCount?: number;
}

export interface TrackerConfig {
	apps: Record<string, AppConfig>;
	/** Most rows the Worker writes per UTC day, across every app. Default 20,000. */
	dailyRowCap?: number;
	/** Largest request body the Worker reads, in bytes. Default 8,192. */
	maxBodyBytes?: number;
}

export const DEFAULTS = { maxRows: 100, maxCount: 10_000_000, dailyRowCap: 20_000, maxBodyBytes: 8192 } as const;

export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const VALUE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** Check a config and return it, or throw with every problem found. */
export function validateConfig(input: unknown): TrackerConfig {
	const problems: string[] = [];
	const config = input as TrackerConfig;
	if (!isObject(input) || !isObject(config.apps) || Object.keys(config.apps).length === 0) {
		throw new Error("tracker config: `apps` must be an object with at least one app");
	}
	for (const [name, app] of Object.entries(config.apps)) {
		const at = `apps.${name}`;
		if (!APP_NAME.test(name)) problems.push(`${at}: app name must match ${APP_NAME}`);
		if (!isObject(app)) {
			problems.push(`${at}: must be an object`);
			continue;
		}
		if (!isObject(app.dimensions)) problems.push(`${at}.dimensions: must be an object`);
		else {
			for (const [dimension, values] of Object.entries(app.dimensions)) {
				if (!FIELD_NAME.test(dimension)) problems.push(`${at}.dimensions.${dimension}: name must match ${FIELD_NAME}`);
				if (!Array.isArray(values) || values.length === 0) problems.push(`${at}.dimensions.${dimension}: must list at least one value`);
				else for (const value of values) if (typeof value !== "string" || !VALUE.test(value)) problems.push(`${at}.dimensions.${dimension}: value ${JSON.stringify(value)} must match ${VALUE}`);
			}
		}
		if (!Array.isArray(app.counts) || app.counts.length === 0) problems.push(`${at}.counts: must list at least one count`);
		else for (const count of app.counts) if (typeof count !== "string" || !FIELD_NAME.test(count)) problems.push(`${at}.counts: ${JSON.stringify(count)} must match ${FIELD_NAME}`);
		for (const key of ["maxRows", "maxCount"] as const) {
			if (app[key] !== undefined && !(Number.isInteger(app[key]) && (app[key] as number) > 0)) problems.push(`${at}.${key}: must be a positive integer`);
		}
	}
	for (const key of ["dailyRowCap", "maxBodyBytes"] as const) {
		if (config[key] !== undefined && !(Number.isInteger(config[key]) && (config[key] as number) > 0)) problems.push(`${key}: must be a positive integer`);
	}
	if (problems.length > 0) throw new Error(`tracker config:\n  ${problems.join("\n  ")}`);
	return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

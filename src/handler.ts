import { DEFAULTS, type TrackerConfig } from "./config.js";
import { parseReport, type Report } from "./report.js";

/**
 * The HTTP API.
 *
 *   POST /v1/report   store one report: 204, or 400 / 413 / 429 with a JSON error
 *   GET  /v1/health   200 {"ok":true,"tracker":"<version>","apps":[...]}
 *
 * Anyone can call the endpoint, because client code is public. The Worker
 * stores only what the config allows, sets the day from its own clock, keeps
 * one report per app, install and day, and stops writing once the day's rows
 * pass a cap. It never stores the caller's IP address.
 */

/** The slice of D1's API the Worker uses, so tests can supply a fake. */
export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	first<T>(): Promise<T | null>;
}
export interface D1Like {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<unknown>;
}
export interface Env {
	DB: D1Like;
}

export async function handle(request: Request, env: Env, config: TrackerConfig, trackerVersion: string, now: Date = new Date()): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/v1/health") {
		if (request.method !== "GET") return status(405, { allow: "GET" });
		return json(200, { ok: true, tracker: trackerVersion, apps: Object.keys(config.apps) });
	}
	if (pathname !== "/v1/report") return status(404);
	if (request.method !== "POST") return status(405, { allow: "POST" });

	const body = await readCapped(request, config.maxBodyBytes ?? DEFAULTS.maxBodyBytes);
	if (body === undefined) return json(413, { error: "body too large" });
	const parsed = parseReport(config, body);
	if (!parsed.ok) return json(400, { error: parsed.error });
	const { report } = parsed;

	const day = now.toISOString().slice(0, 10);
	const used = await env.DB.prepare("SELECT rows FROM daily_writes WHERE day = ?").bind(day).first<{ rows: number }>();
	if ((used?.rows ?? 0) + report.rows.length > (config.dailyRowCap ?? DEFAULTS.dailyRowCap)) {
		return json(429, { error: "daily cap reached" });
	}

	try {
		await write(env, report, day);
	} catch {
		// A database error is the tracker's fault, not the report's: answer 503 so
		// the client keeps the report and retries it on a later day.
		return json(503, { error: "storage unavailable" });
	}
	return status(204);
}

async function write(env: Env, report: Report, day: string): Promise<void> {
	await env.DB.batch([
		// A second report on the same day replaces the first.
		env.DB.prepare("DELETE FROM reports WHERE app = ? AND day = ? AND install_id = ?").bind(report.app, day, report.installId),
		...report.rows.map((row) =>
			env.DB.prepare("INSERT INTO reports (app, day, install_id, version, dims, counts) VALUES (?, ?, ?, ?, ?, ?)").bind(
				report.app,
				day,
				report.installId,
				report.version,
				row.dims,
				JSON.stringify(row.counts),
			),
		),
		env.DB.prepare("INSERT INTO daily_writes (day, rows) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows").bind(
			day,
			report.rows.length,
		),
	]);
}

/** Read at most `limit` bytes of the body, whatever `Content-Length` claims. Undefined when the body is larger. */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function status(code: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status: code, headers });
}

function json(code: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
}

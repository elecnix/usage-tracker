import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { validateConfig, type TrackerConfig } from "../src/config.js";
import { parseReport } from "../src/report.js";
import { handle, type D1Like, type D1Statement } from "../src/handler.js";
import { sendReport } from "../clients/typescript/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATION = path.join(ROOT, "migrations", "0001_reports.sql");
const NOW = new Date("2026-10-09T12:00:00Z");
const INSTALL = "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69";

const config: TrackerConfig = {
	apps: {
		"example-cli": {
			dimensions: { command: ["init", "build"], os: ["linux", "darwin"] },
			counts: ["runs", "failures"],
			maxRows: 5,
			maxCount: 1000,
		},
	},
	dailyRowCap: 10,
	maxBodyBytes: 1024,
};

function report(rows: unknown[] = [{ dimensions: { command: "build", os: "linux" }, counts: { runs: 3, failures: 1 } }], overrides: Record<string, unknown> = {}) {
	return { app: "example-cli", installId: INSTALL, version: "1.2.3", rows, ...overrides };
}

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

function parseError(value: unknown): string | undefined {
	const result = parseReport(config, bytes(value));
	return result.ok ? undefined : result.error;
}

/** D1's API over better-sqlite3, so the real migration and its CHECKs apply. */
function fakeD1(db: Database.Database): D1Like {
	const statement = (sql: string, values: unknown[] = []): D1Statement & { run(): void } => ({
		bind: (...next: unknown[]) => statement(sql, next),
		first: async <T>() => (db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: () => void db.prepare(sql).run(...values),
	});
	return {
		prepare: (sql) => statement(sql),
		batch: async (statements) => db.transaction(() => statements.forEach((s) => (s as ReturnType<typeof statement>).run()))(),
	};
}

const post = (body: unknown) => new Request("https://tracker.test/v1/report", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("validateConfig", () => {
	it("accepts the example config", () => {
		validateConfig(JSON.parse(fs.readFileSync(path.join(ROOT, "examples", "tracker.config.json"), "utf-8")));
	});

	it("lists every problem it finds", () => {
		assert.throws(
			() => validateConfig({ apps: { "Bad Name": { dimensions: { os: [] }, counts: ["has space"] } }, dailyRowCap: -1 }),
			(err: Error) => /app name/.test(err.message) && /at least one value/.test(err.message) && /has space/.test(err.message) && /dailyRowCap/.test(err.message),
		);
	});
});

describe("parseReport", () => {
	it("accepts a report and fills missing counts with 0", () => {
		const result = parseReport(config, bytes(report([{ dimensions: { os: "linux", command: "build" }, counts: { runs: 3 } }])));
		assert.deepEqual(result, {
			ok: true,
			report: { app: "example-cli", installId: INSTALL, version: "1.2.3", rows: [{ dims: '{"command":"build","os":"linux"}', counts: { runs: 3, failures: 0 } }] },
		});
	});

	it("stores a dimension value outside the list as other, and sums rows that then collide", () => {
		const result = parseReport(
			config,
			bytes(report([
				{ dimensions: { command: "future-a", os: "linux" }, counts: { runs: 1 } },
				{ dimensions: { command: "future-b", os: "linux" }, counts: { runs: 2 } },
			])),
		);
		assert.ok(result.ok);
		assert.deepEqual(result.report.rows, [{ dims: '{"command":"other","os":"linux"}', counts: { runs: 3, failures: 0 } }]);
	});

	it("rejects anything outside the config", () => {
		assert.match(parseError({ ...report(), extra: 1 }) ?? "", /exactly the keys/);
		assert.match(parseError(report(undefined, { app: "other-app" })) ?? "", /unknown app/);
		assert.match(parseError(report(undefined, { installId: "abc" })) ?? "", /installId/);
		assert.match(parseError(report(undefined, { version: "1.2" })) ?? "", /version/);
		assert.match(parseError(report([{ dimensions: { command: "build" }, counts: {} }])) ?? "", /dimensions must have exactly/);
		assert.match(parseError(report([{ dimensions: { command: "Free text!", os: "linux" }, counts: {} }])) ?? "", /must match/);
		assert.match(parseError(report([{ dimensions: { command: "build", os: "linux" }, counts: { title: 1 } }])) ?? "", /not a count/);
		assert.match(parseError(report([{ dimensions: { command: "build", os: "linux" }, counts: { runs: -1 } }])) ?? "", /integer/);
		assert.match(parseError(report([{ dimensions: { command: "build", os: "linux" }, counts: { runs: 1001 } }])) ?? "", /integer/);
		assert.match(parseError(report(Array(6).fill({ dimensions: { command: "build", os: "linux" }, counts: {} }))) ?? "", /at most 5/);
		assert.match(parseError("not json") ?? "", /JSON/);
	});
});

describe("the Worker", () => {
	let db: Database.Database;
	let env: { DB: D1Like };

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(fs.readFileSync(MIGRATION, "utf-8"));
		env = { DB: fakeD1(db) };
	});

	const rows = () => db.prepare("SELECT app, day, install_id, version, dims, counts FROM reports ORDER BY dims").all();

	it("stores a report under the server's UTC day and answers 204", async () => {
		assert.equal((await handle(post(report()), env, config, "0.1.0", NOW)).status, 204);
		assert.deepEqual(rows(), [
			{ app: "example-cli", day: "2026-10-09", install_id: INSTALL, version: "1.2.3", dims: '{"command":"build","os":"linux"}', counts: '{"runs":3,"failures":1}' },
		]);
	});

	it("replaces an install's earlier report for the same day", async () => {
		await handle(post(report()), env, config, "0.1.0", NOW);
		await handle(post(report([{ dimensions: { command: "init", os: "darwin" }, counts: { runs: 9 } }])), env, config, "0.1.0", NOW);
		assert.deepEqual(rows().map((r) => (r as { dims: string }).dims), ['{"command":"init","os":"darwin"}']);
	});

	it("answers 400 with the reason, and stores nothing", async () => {
		const response = await handle(post({ ...report(), extra: true }), env, config, "0.1.0", NOW);
		assert.equal(response.status, 400);
		assert.match(((await response.json()) as { error: string }).error, /exactly the keys/);
		assert.deepEqual(rows(), []);
	});

	it("answers 413 for a body over the cap by the bytes it reads, whatever Content-Length says", async () => {
		const request = new Request("https://tracker.test/v1/report", { method: "POST", body: " ".repeat(2048), headers: { "content-length": "10" } });
		assert.equal((await handle(request, env, config, "0.1.0", NOW)).status, 413);
	});

	it("answers 429 once the day's rows pass the cap", async () => {
		db.prepare("INSERT INTO daily_writes (day, rows) VALUES (?, ?)").run("2026-10-09", 10);
		assert.equal((await handle(post(report()), env, config, "0.1.0", NOW)).status, 429);
		assert.deepEqual(rows(), []);
	});

	it("answers 503 when the database fails, so the client retries later", async () => {
		const broken: D1Like = { ...env.DB, batch: async () => Promise.reject(new Error("D1 down")) };
		assert.equal((await handle(post(report()), { DB: broken }, config, "0.1.0", NOW)).status, 503);
	});

	it("reports its version and apps on /v1/health", async () => {
		const response = await handle(new Request("https://tracker.test/v1/health"), env, config, "0.1.0", NOW);
		assert.deepEqual(await response.json(), { ok: true, tracker: "0.1.0", apps: ["example-cli"] });
	});

	it("answers 404 off the API and 405 for the wrong method", async () => {
		assert.equal((await handle(new Request("https://tracker.test/"), env, config, "0.1.0", NOW)).status, 404);
		assert.equal((await handle(new Request("https://tracker.test/v1/report"), env, config, "0.1.0", NOW)).status, 405);
	});
});

describe("the TypeScript client", () => {
	it("posts to /v1/report and reports the Worker's error", async () => {
		let url = "";
		const ok = await sendReport("https://tracker.test", report() as never, {
			fetch: async (input) => ((url = String(input)), new Response(null, { status: 204 })),
		});
		assert.deepEqual(ok, { ok: true });
		assert.equal(url, "https://tracker.test/v1/report");
		const refused = await sendReport("https://tracker.test", report() as never, {
			fetch: async () => new Response(JSON.stringify({ error: "unknown app" }), { status: 400 }),
		});
		assert.deepEqual(refused, { ok: false, status: 400, error: "unknown app" });
	});
});

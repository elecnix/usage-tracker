#!/usr/bin/env node
// Deploy the tracker to a Cloudflare account.
//
//   npm run deploy -- --config <tracker.config.json> --name <worker-name> [--database <d1-name>] [--dry-run]
//
// The account comes from the environment: CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN (CI), or a `wrangler login` session (a laptop). The
// script creates the D1 database when it doesn't exist, applies migrations,
// and deploys the Worker with the config built in. It prints the Worker's URL.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = path.join(ROOT, ".generated");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");

const args = parseArgs(process.argv.slice(2));
if (!args.config || !args.name) {
	console.error("Usage: npm run deploy -- --config <tracker.config.json> --name <worker-name> [--database <d1-name>] [--dry-run]");
	process.exit(2);
}
const databaseName = args.database ?? args.name;
// npm runs scripts from the package root; resolve the path from where the user ran npm.
const config = JSON.parse(fs.readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), args.config), "utf-8"));
const { validateConfig } = await import(path.join(ROOT, "src", "config.ts"));
validateConfig(config);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;

const databaseId = args["dry-run"] ? "00000000-0000-0000-0000-000000000000" : findOrCreateDatabase(databaseName);
fs.mkdirSync(GENERATED, { recursive: true });
const wranglerConfig = path.join(GENERATED, "wrangler.json");
fs.writeFileSync(
	wranglerConfig,
	JSON.stringify(
		{
			name: args.name,
			main: "../src/index.ts",
			compatibility_date: "2026-09-01",
			workers_dev: true,
			observability: { enabled: false },
			define: { __TRACKER_CONFIG__: JSON.stringify(config), __TRACKER_VERSION__: JSON.stringify(version) },
			d1_databases: [{ binding: "DB", database_name: databaseName, database_id: databaseId, migrations_dir: "../migrations" }],
		},
		null,
		2,
	),
);

if (args["dry-run"]) {
	wrangler(["deploy", "--dry-run", "--outdir", path.join(GENERATED, "dist"), "-c", wranglerConfig]);
	console.log(`Dry run: built tracker ${version} for ${Object.keys(config.apps).join(", ")}.`);
	process.exit(0);
}
wrangler(["d1", "migrations", "apply", databaseName, "--remote", "-c", wranglerConfig]);
const deployed = wrangler(["deploy", "-c", wranglerConfig]);
const url = deployed.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
console.log(`Deployed tracker ${version} as ${args.name}${url ? ` at ${url}` : ""}.`);

function findOrCreateDatabase(name) {
	const list = JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true }));
	const found = list.find((db) => db.name === name);
	if (found) return found.uuid;
	const created = wrangler(["d1", "create", name]);
	const id = created.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] ?? created.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];
	if (!id) throw new Error(`Created D1 database ${name}, but couldn't read its id from wrangler's output.`);
	return id;
}

function wrangler(argv, { quiet = false } = {}) {
	const result = spawnSync(WRANGLER, argv, {
		cwd: ROOT,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: process.env.CI ?? "1" },
	});
	if (!quiet) process.stdout.write(result.stdout);
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		throw new Error(`wrangler ${argv.join(" ")} exited with ${result.status}`);
	}
	return result.stdout;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i].replace(/^--/, "");
		if (key === "dry-run") out[key] = true;
		else out[key] = argv[++i];
	}
	return out;
}

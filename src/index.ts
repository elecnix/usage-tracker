import { validateConfig, type TrackerConfig } from "./config.js";
import { handle, type Env } from "./handler.js";

/**
 * The Worker entry. `scripts/deploy.mjs` injects the deployment's config and
 * the tracker version at build time through wrangler's `define`.
 */
declare const __TRACKER_CONFIG__: unknown;
declare const __TRACKER_VERSION__: string;

let config: TrackerConfig | undefined;

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		config ??= validateConfig(__TRACKER_CONFIG__);
		return handle(request, env, config, __TRACKER_VERSION__);
	},
};

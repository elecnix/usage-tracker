/**
 * A dependency-free client for the tracker's HTTP API. Copy this file into a
 * project, or call the API directly: it's one JSON POST.
 */

export interface ReportRow {
	dimensions: Record<string, string>;
	counts: Record<string, number>;
}

export interface Report {
	app: string;
	/** A random UUID the install keeps, and may replace at any time. */
	installId: string;
	/** MAJOR.MINOR.PATCH of the reporting tool. */
	version: string;
	rows: ReportRow[];
}

export type SendResult = { ok: true } | { ok: false; status?: number; error: string };

/**
 * POST one report. Never throws. Treat anything but `ok` as "try again on a
 * later day": a 4xx means the report doesn't match the tracker's config, and
 * retrying it unchanged won't help.
 */
export async function sendReport(endpoint: string, report: Report, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<SendResult> {
	try {
		const response = await (options.fetch ?? fetch)(new URL("/v1/report", endpoint), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(report),
			signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
		});
		if (response.ok) return { ok: true };
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		return { ok: false, status: response.status, error: body.error ?? `HTTP ${response.status}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

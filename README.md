# usage-tracker

Anonymous daily usage counts for open-source tools. You deploy a Cloudflare Worker and a D1 database to your own account. Your tool then POSTs one small JSON report a day. The Worker stores only the dimensions and counts your config lists, so a report has nowhere to put user text, file paths, or anything else you didn't plan for.

Both services run on Cloudflare's free plan. At the free plan's limits, requests fail instead of being billed.

## How a report looks

```http
POST /v1/report
Content-Type: application/json

{
  "app": "example-cli",
  "installId": "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69",
  "version": "1.4.2",
  "rows": [
    { "dimensions": { "command": "build", "os": "linux" }, "counts": { "runs": 12, "failures": 1, "durationSec": 340 } },
    { "dimensions": { "command": "deploy", "os": "linux" }, "counts": { "runs": 2 } }
  ]
}
```

- `app` is one of the apps in your config.
- `installId` is a random lowercase UUID that the install keeps. Let users replace it.
- `version` is your tool's version, as `MAJOR.MINOR.PATCH`.
- Each row names every dimension of the app. A value missing from the config's list is stored as `other`, so you can add values to a client before you redeploy the Worker.
- `counts` may leave out any count, and the Worker stores 0 for it. A count the config doesn't list is an error.

| Answer | Meaning |
|---|---|
| `204` | Stored. A second report from the same install on the same UTC day replaces the first. |
| `400` | The report doesn't match the config. The JSON body's `error` says why. Don't retry it unchanged. |
| `413` | The body is larger than `maxBodyBytes`. |
| `429` | The Worker has written `dailyRowCap` rows today. Retry tomorrow. |
| `503` | The database failed. Retry later. |

`GET /v1/health` answers `{"ok":true,"tracker":"0.1.0","apps":["example-cli"]}`.

## Calling it from any language

The API is one JSON POST, so you don't need a client library.

```sh
curl -X POST "$TRACKER_URL/v1/report" -H 'content-type: application/json' -d @report.json
```

```python
import json, urllib.request
req = urllib.request.Request(f"{TRACKER_URL}/v1/report", data=json.dumps(report).encode(), headers={"content-type": "application/json"})
urllib.request.urlopen(req, timeout=3)
```

```go
body, _ := json.Marshal(report)
http.Post(trackerURL+"/v1/report", "application/json", bytes.NewReader(body))
```

For TypeScript, [`clients/typescript/index.ts`](clients/typescript/index.ts) is one file with no dependencies. Copy it into your project.

## Configuring an app

The config lists each app's dimensions, with the values each one may take, and the names of its counts. See [`examples/tracker.config.json`](examples/tracker.config.json).

```json
{
  "apps": {
    "example-cli": {
      "dimensions": { "command": ["init", "build", "deploy"], "os": ["linux", "darwin", "win32"] },
      "counts": ["runs", "failures", "durationSec"],
      "maxRows": 100,
      "maxCount": 10000000
    }
  },
  "dailyRowCap": 20000,
  "maxBodyBytes": 8192
}
```

| Field | Rule |
|---|---|
| App names | Lowercase letters, digits, and dashes, up to 48 characters |
| Dimension and count names | A letter, then letters, digits, or underscores, up to 32 characters |
| Dimension values | Lowercase letters, digits, `.`, `_`, and `-`, up to 48 characters |
| `maxRows` | Most rows in one report. Default 100. |
| `maxCount` | Largest value a count may take. Default 10,000,000. |
| `dailyRowCap` | Most rows written per UTC day, across all apps. Default 20,000, which keeps you under D1's free limit of 100,000 rows written a day. |
| `maxBodyBytes` | Largest body the Worker reads. Default 8,192. |

One deployment can serve several apps. Keep the config in the repository of the tool that sends the reports, so that a change to it goes through review.

## Deploying

You need Node 22 or later and a Cloudflare account.

```sh
git clone https://github.com/elecnix/usage-tracker && cd usage-tracker
npm ci
npx wrangler login     # or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run deploy -- --config path/to/tracker.config.json --name my-tool-telemetry
```

The script creates the D1 database if it doesn't exist (named after `--name`, or `--database <name>`), applies the migrations, builds the config into the Worker, and deploys it. It prints the Worker's URL. Add `--dry-run` to check the config and build without deploying.

Your account needs a workers.dev subdomain. If it doesn't have one, wrangler says so on the first deploy.

### From CI

Create an API token with the **Edit Cloudflare Workers** template plus **D1: Edit**, and store it with the account id as secrets. Then pin a tracker version in your repository and deploy when the pin or the config changes:

```yaml
on:
  push:
    branches: [main]
    paths: [telemetry/tracker-version, telemetry/tracker.config.json]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: pin
        run: echo "ref=$(cat telemetry/tracker-version)" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        with: { repository: elecnix/usage-tracker, ref: "${{ steps.pin.outputs.ref }}", path: tracker }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run deploy -- --config ../telemetry/tracker.config.json --name my-tool-telemetry
        working-directory: tracker
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Reading the data

Each row stores the app, the UTC day, the install id, the version, and the dimensions and counts as JSON. Query it with `wrangler d1 execute`:

```sh
npx wrangler d1 execute my-tool-telemetry --remote --command "
  SELECT json_extract(dims, '$.command') AS command,
         COUNT(DISTINCT install_id) AS installs,
         SUM(json_extract(counts, '$.runs')) AS runs
    FROM reports
   WHERE app = 'example-cli' AND day >= date('now', '-30 days')
   GROUP BY command ORDER BY runs DESC"
```

Anyone can send reports, so read the totals with that in mind. Prefer medians across installs over raw sums, and cap how much one install can contribute.

## What the Worker does to keep junk out

- It reads at most `maxBodyBytes`, counting the bytes it reads rather than trusting `Content-Length`.
- It rejects any key, app, dimension, or count the config doesn't list, and any count outside its range.
- It sets the day from its own clock.
- It keeps one report per app, install, and day.
- It stops writing for the day at `dailyRowCap`.
- It never stores the caller's IP address.
- The D1 table repeats size and format limits as `CHECK` constraints.

## Being a good citizen

- Ask before you send anything, and keep reports off until the user says yes.
- Honor `DO_NOT_TRACK=1`.
- Offer a way to print the next report without sending it.
- Send at most once a day, and never let a failed send fail the user's command.

## License

MIT

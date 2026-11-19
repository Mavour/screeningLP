# Meteora Whale Radar

Private, read-only dashboard and Telegram alerts for tracked Meteora DLMM wallets. The scanner and Agent Dorm status API run through the existing root package. Radar is installed and started from this directory.

## Run the live public dashboard

Set `WEB_USER` and a bcrypt hash in `WEB_PASSWORD` (see below), then run `npm run start:live`. This starts the dashboard and all public monitoring jobs together. The dashboard binds to loopback on port 9011 by default. It starts with an empty database and collects current data automatically. Set `RADAR_DB` to continue using an existing public database. `pm2 start ecosystem.config.cjs --only whale-radar` runs the same live service with process supervision.

Discovery samples current position owners from distinct established active, new active, medium-volume, and lower-volume pools using Solana RPC. Meteora provides indexed USD deposits. Each sampled pool contributes up to one owner with the most position accounts plus four reproducibly sampled owners. If the position RPC yields no qualifying wallet, discovery falls back to confirmed openings from recent pools and labels that fallback.

The worker runs discovery on startup and repeats 15 minutes after each pass completes by default. Market data and the next batch of tracked wallet pools refresh at two-minute intervals after each pass. A visible dashboard tab checks for updates every 20 seconds and preserves open charts and in-progress edits. The worker subscribes to confirmed Solana logs for the sampled pools, validates liquidity events against the canonical transaction, and waits for Meteora to index the event. A wallet qualifies separately in each pool when its recorded USD deposits across open positions exceed US$2,000. Freshness and provider failures are visible in the dashboard and at `/web/public-status`.

The worker reconnects automatically, catches up on a bounded number of signatures, and rotates through pools using HTTP polling when the stream is unavailable. RPC quotas and Meteora indexing delay affect coverage and latency. View authenticated runtime health at `/web/public-status`. Public Telegram delivery is opt-in.

### Deploy ke VPS Ubuntu

Gunakan akun VPS yang menjalankan PM2 dan Node.js 24 LTS. Dari clone repo yang sudah ada, jalankan:

```bash
git pull --ff-only origin main
cd whale-radar
npm ci --omit=dev
test -f .env || install -m 600 .env.example .env
chmod 600 .env
```

Buat hash untuk password dashboard. Masukkan password saat diminta, lalu salin hasil hash ke `.env`.

```bash
read -rsp 'Password dashboard: ' radar_password; printf '\n'
printf '%s' "$radar_password" | node --input-type=module -e 'import bcrypt from "bcryptjs"; import fs from "node:fs"; console.log(await bcrypt.hash(fs.readFileSync(0, "utf8"), 10))'
unset radar_password
```

Isi nilai berikut di `whale-radar/.env`. Gunakan akun dashboard pilihanmu dan ganti placeholder hash dengan hasil perintah di atas.

```dotenv
MOCK=0
RADAR_WEB_ENABLED=1
RADAR_WEB_PORT=9011
WEB_USER=radar
WEB_PASSWORD='<HASH_BCRYPT>'
RADAR_PUBLIC_TELEGRAM=0
```

```bash
pm2 startOrRestart ecosystem.config.cjs --only whale-radar --update-env
pm2 logs whale-radar --lines 30 --nostream
pm2 save
```

Jika PM2 belum terdaftar untuk boot, jalankan `pm2 startup` dengan akun yang sama dan eksekusi perintah yang ditampilkan. Untuk memeriksa status langsung dari VPS, jalankan `curl -fsS -u radar http://127.0.0.1:9011/web/public-status` dan masukkan password dashboard.

Dari komputer lokal, buka tunnel di terminal dan biarkan terminal itu berjalan saat memakai dashboard:

```bash
ssh -N -L 19011:127.0.0.1:9011 USER_VPS@HOST_VPS
```

Buka [dashboard Radar](http://127.0.0.1:19011/web). Untuk URL dengan domain, gunakan contoh [Nginx HTTPS](docs/nginx.conf) setelah DNS dan sertifikat TLS tersedia. Radar mengumpulkan data publik Solana dan Meteora, termasuk ranking Smart LP, sejak proses dimulai.

### Smart LP with public data

The public worker automatically builds `/web/leaderboard` from Solana position owners sampled across the monitored pool groups, observed whales, favorites, and previously ranked wallets. The US$2,000 whale threshold is independent of Smart LP screening. The leaderboard shows coverage, incomplete wallet histories, last published ranking, and each candidate's follow-up status. It ranks the measured sample.

The worker paginates closed pools and position records from Meteora, applies the exact rolling window to position close times, and reconciles deposit, withdrawal, fee, and PnL in SOL before scoring. History that fails reconciliation or hits the configured page cap is excluded. The 30-day minimum-position, average-deposit, profit-concentration, and short-hold activity filters still apply. Scoring uses PnL, ROI, and win rate with weights of 50/30/20.

Public candidates use the follow-up hold benchmark below with Meteora's indexed event and candle data and confirmed Solana transaction fees. This public path needs no LP Agent key. Fee, transfer, and price coverage limits can leave the outcome inconclusive. `RADAR_DISCOVERY_MINUTES` controls ranking and follow-up cadence, independently of the wallet sampling interval. The Agent Dorm payload carries the same ranking under `metrics.whaleRadar.smartLp`.

### Agent Dorm and Telegram

- Untuk mengaktifkan notifikasi dan menautkan `/web` ke VPS, ikuti [panduan Telegram dan akses dashboard melalui IP](docs/telegram-vps.md).
- Configure `RADAR_DORM_API_KEY` on the Radar web process. Agent Dorm uses `ALERT_MODE=http`, `ALERT_URL=http://127.0.0.1:9011/api/agent-dorm` (or the configured dashboard port), and the same value as `ALERT_API_KEY`. The adapter appends `/status`. The independent Bearer credential remains server-side. Use HTTPS or a private tunnel between hosts.
- Run `npm run preview:telegram` with the public `RADAR_DB` to print the newest qualifying opening without sending a message. Set `RADAR_PUBLIC_TELEGRAM=1` and configure `TELEGRAM_BOT_TOKEN` and `RADAR_CHAT_ID` on the public worker to deliver new openings. Starting delivery excludes openings from before opt-in. The public feed and messages use the same deposit, fee, pool, and verification fields.

## Run offline

Use Node.js 20.19+ on the 20.x line, or Node.js 22.12+ (24 LTS recommended), and install with `npm ci`. Tests use `npm test`. Commands below use POSIX shell syntax. In PowerShell, set the variables with `$env:MOCK='1'` and `$env:RADAR_BATCH_SECONDS='0'` before running the equivalent npm commands.

```sh
export MOCK=1 RADAR_BATCH_SECONDS=0
npm run leaderboard
npm run start:bot -- --dry-run --replay 2SpWEJ2KDYDLHuZTEH4xt1PLwSV4pQLqaYtBQWV52E6pJrrSSsQZTsz2CbzKAhzseyPJmQYnrgZ2ghTs63FYXCLF
npm run start:bot -- --dry-run
```

Open [http://127.0.0.1:9011/web](http://127.0.0.1:9011/web). Mock credentials are `mock` / `whale-radar-mock` unless overridden. The mock webhook accepts POST at `http://127.0.0.1:9012/hooks/helius` with `Authorization: mock-webhook` and body `[{"signature":"<fixture signature above>","transactionError":null}]`. Use a fresh `RADAR_DB` to see initial ingestion again. The mock database defaults to `data/mock.sqlite`.

## Smart LP verification

- **Radar rank** is computed within Radar's candidate set. The optional LP Agent integration also records provider pool rank, ordered by native PnL, with its pool, metric and timestamp.
- Eligible pools are selected round-robin by age, volume, and observed 24-hour volatility within a bounded scan. A reproducibly chosen wallet from a lower LP Agent page serves as a comparison when available. That comparison represents a sample of lower-ranked LP Agent listings, with the same follow-up rules as the candidate cohort.
- The next 30 days are frozen at enrollment by default. Wallets are retained when they drop off the ranking or go inactive. The Smart LP page reports incomplete follow-ups as well as conclusive results for each group.
- Promotion requires sufficient closed positions, complete benchmark evidence, and positive net outcomes across at least three follow-up weeks. For the optional LP Agent integration, closed position IDs and PnL must also match Meteora within configured tolerances. The public worker checks completeness and reconciles the Meteora position totals and event histories. The same limit on one-position profit concentration applies to benchmark excess. Positions held through the follow-up cutoff can contribute losses, including when they close between cutoff and evaluation. Gains after the cutoff are excluded.
- The implemented hold benchmark supports SOL-paired positions. It values both the exact assets deposited and the retained LP withdrawals and claimed trading fees at the same last completed 5-minute Meteora pool candle before closing. The benchmark reconciles indexed transfers against position totals and debits wallet-paid Solana fees from confirmed indexed lifecycle transactions. It excludes reward-token incentives and uses an indexed pool price estimate. Unsupported pairs, missing candles, unresolved reconciliation, or unavailable transactions produce insufficient evidence.
- A verified candidate gets the Smart LP badge for up to one follow-up window after the assessed period ends. Comparison wallets and regular tracked wallet alerts never acquire the badge based solely on that group's results. Open money amounts and the US$2,000 whale threshold are displayed separately.

## Test the optional LP Agent integration locally

Set `LP_AGENT_API_KEY` in the ignored `whale-radar/.env` file and run `npm run check:live`. It checks Meteora discovery, Solana RPC, LP Agent pool rank and closed history, and samples Meteora's PnL for the same positions. The check exits nonzero on failure and does not open SQLite or send alerts.

In PowerShell, set the following from `whale-radar/`. Configure the same dashboard credentials described below. Use public Solana RPC for a short smoke test if you have no configured RPC provider.

```powershell
$env:MOCK='0'
$env:RADAR_LIVE='1'
$env:RADAR_DB='data/local-live.sqlite'
$env:RADAR_WEB_PORT='9014'
$env:HELIUS_WEBHOOK_URL=''
$env:HELIUS_WEBHOOK_AUTH=''
# Optional when testing without Helius or a dedicated RPC
# $env:RADAR_RPC_URL='https://api.mainnet-beta.solana.com'
npm run check:live
if ($LASTEXITCODE -eq 0) { npm run start:bot -- --dry-run }
```

Watch for `Leaderboard refreshed` in the worker logs, then open [Smart LP on localhost](http://127.0.0.1:9014/web/leaderboard). The first pass can take several minutes at the configured LP Agent quota. Newly enrolled wallets start a forward evaluation. Telegram deliveries are previewed in the worker output.

## Production onboarding with LP Agent

1. On Ubuntu, run `npm ci` in the root scanner and separately in `whale-radar/`. Keep the scanner's PM2 process running as before. Copy the radar `.env.example` to `.env` and set permissions with `chmod 600 .env`.
2. Set `RADAR_LIVE=1`, an LP Agent Premium/Enterprise API key and the correct `LP_AGENT_RPM`, a Jupiter key, and Helius credentials or a Solana RPC and WebSocket endpoint. Export only the required credentials. The radar-specific `.env` takes precedence over the scanner's `.env`; shell variables take precedence over both.
3. Set `WEB_USER`, a bcrypt hash in `WEB_PASSWORD`, and the HTTPS `RADAR_PUBLIC_URL` when exposing the dashboard. Generate a cost-10 hash without passing the password as a command argument.

   ```sh
   read -rs -p 'Dashboard password: ' radar_password; printf '\n'
   printf '%s' "$radar_password" | node --input-type=module -e 'import bcrypt from "bcryptjs"; import fs from "node:fs"; console.log(await bcrypt.hash(fs.readFileSync(0,"utf8"),10))'
   unset radar_password
   ```

4. Configure [Nginx](docs/nginx.conf) with the actual hostname and TLS certificate, run `nginx -t`, then reload it. For Helius webhook mode, create a dedicated enhanced webhook in Helius with the public HTTPS URL ending in `/hooks/helius`. Supply its ID, URL, and an independent random Authorization secret via `HELIUS_WEBHOOK_ID`, `HELIUS_WEBHOOK_URL`, and `HELIUS_WEBHOOK_AUTH`. Radar updates the address list. With the URL absent, Radar uses Solana WebSocket notifications.
5. Run `npm run leaderboard` and `npm run start:bot -- --dry-run` with a dedicated dry-run database. Check coverage, provider logs, Telegram previews, and dashboard. Live dry-run records preview delivery in its own database. Live `--replay <signature>` always previews against a temporary database seeded from the current watchlist.
6. Set a new or existing live `RADAR_DB` and the Telegram destination `RADAR_CHAT_ID` or scanner `ALLOWED_CHAT_ID`. Use the existing Telegram token. Start the optional LP Agent worker from this directory with `pm2 start src/cli.js --name whale-radar-paid -- bot`. Monitor `pm2 logs whale-radar-paid` during first discovery and delivery, then use `pm2 save` if appropriate for the VPS.

One Radar PM2 instance owns its event inbox and alert outbox. The dashboard runs inside that process by default. For an independent dashboard process, set `RADAR_WEB_ENABLED=0` on the worker and run `npm run start:web` with the same database and web credentials. Both servers bind loopback. The dashboard uses HTTP Basic over HTTPS and refuses to start without a bcrypt hash. Use `pm2 stop whale-radar-paid` to stop the LP Agent worker.

## Jobs, sizing, and coverage

- `npm run backfill -- <wallet>` indexes the wallet's open positions and available closed history. Mark it favorite on its profile to subscribe regardless of rank. Blacklisted wallets remain visible in history. `npm run reclassify` recomputes distributions from stored bin snapshots.
- Discovery uses configurable pool, candidate and history budgets. The default scans the top 20 eligible pools every six hours and compares up to 30 scored candidates with Meteora. Favorite and regular refresh targets are 5 and 30 minutes after successful refresh. Provider quota and wallet history size can increase the lag.
- Telegram requires over US$2,000 in the wallet's open-position deposits in that pool, verified with Meteora, plus the configured minimum SOL-equivalent size for the new transaction. A partially priced transaction is marked with ≥ and qualifies only when its measured amount clears the SOL minimum. Delivery retries preserve recorded alerts across restart.
- Trending weights default to 45 for fees/TVL, 20 for 1h volume momentum versus the 24h hourly baseline, 10 for TVL, 5 for age, 20 for tracked wallets (top ranks receive a larger bonus), and a 10-point penalty per known risk flag. FDV and age filters are configurable. The fee APR estimate annualizes trailing 24h fees/TVL and excludes trading outcomes.
- Back up the database with SQLite's online backup command, for example `sqlite3 data/radar.sqlite ".backup /srv/backups/radar.sqlite"`. Export CSV/JSON from the dashboard for analysis. Store backups with private file permissions.

See [provider contracts](docs/api-notes.md) and [strategy notes](docs/strategy-notes.md) for field semantics and checks.

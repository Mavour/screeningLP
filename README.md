# Solana LP Scanner

Bot Node.js (PM2) yang scan pool DLMM Meteora setiap 5 menit, filter secara deterministik, lalu kirim rekomendasi + risk note ke Telegram. **Alert-only** — tidak pernah swap atau add LP.

## Yang dipakai

| Sumber | Untuk |
|---|---|
| [Meteora pool-discovery](https://pool-discovery-api.datapi.meteora.ag/pools) (tab Trending) | TVL, volume 24h, **total LPs**, **volatility**, creator %, top-10, mint/freeze, fee/TVL |
| [DexPaprika](https://dexpaprika.com/) | Volume **5m / 1h / 6h / 24h**, OHLCV, umur token/pool |
| RugCheck | Security score, insider, fallback mint/freeze |
| Solana RPC | Cek wallet KOL on-chain (hold / tidak) |
| DexScreener | Link chart + sanity-check liquidity |
| GMGN | Opsional, kalau `GMGN_API_KEY` ada |

Tidak ada LLM di jalur keputusan. Input sama → output sama.

## Trigger default

- Volume **24h pool ≥ $1M** (ini yang menembakkan rekomendasi)
- Creator **0% / sold all** (`dev_balance_pct ≤ 0.01`)
- Mint & freeze authority revoked
- Bukan blacklist Meteora
- 4 timeframe volume (5m/1h/6h/24h) **selalu ditampilkan** di hasil supaya bisa dicek semua

KOL ada 2 list:

1. **avoid** — koin tetap bisa lolos, tapi dapat warning
2. **green** — koin dapat catatan baik + badge

## Telegram (private, chat kamu saja)

Set `ALLOWED_CHAT_ID` di `.env`. Bot mengabaikan chat lain.

Hanya dua command: `/start` dan `/menu`. Semuanya tombol.

| Tombol | Fungsi |
|---|---|
| Pool menarik | Coin yang lolos filter (hasil scan terakhir) |
| Scan sekarang | Jalanin cycle sekali |
| Status | Heartbeat + semua threshold aktif |
| Pause / Resume | Stop atau jalanin cron 5 menit |
| Filter Liquidity / Holder / Risk / Age / Discovery | Ubah threshold (tap → ketik angka / pilih opsi) |
| KOL avoid / green | List, tambah, hapus wallet |
| Reset config default | Kembalikan threshold pabrik |

Alert otomatis hanya untuk pool yang **belum pernah** dikirim (state persist di `data/seen-pools.json`). **Pool menarik** tetap menampilkan semua yang lolos filter saat scan terakhir.

## Deploy Ubuntu + PM2

```bash
sudo apt update
sudo apt install -y nodejs npm
sudo npm i -g pm2

git clone <repo> && cd screeningLP
cp .env.example .env
nano .env          # isi TELEGRAM_BOT_TOKEN + ALLOWED_CHAT_ID + SOLANA_RPC_URL
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup
pm2 logs lp-scanner
```

Cek sekali tanpa bot:

```bash
node src/index.js --once
```

## Env penting

Lihat `.env.example`. Minimal:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_ID` — angka chat id kamu (`@userinfobot`)
- `SOLANA_RPC_URL` — default RPC publik (gratis)
- `HELIUS_API_KEY` — fallback otomatis kalau RPC publik kena 429/timeout

### RPC: publik dulu, Helius cadangan

Default: pakai `https://api.mainnet-beta.solana.com`. Isi `HELIUS_API_KEY` di `.env` — kalau publik gagal, bot pindah ke Helius sendiri.

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=isi-api-key-helius
```

Mau Helius jadi **utama** (lebih stabil 24/7):

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=isi-api-key-helius
```

DexPaprika keyless cukup (30 req/menit). Cycle 5 menit + enrichment terbatas aman di limit itu.

## Struktur

```
src/
  services/     Meteora, DexPaprika, RugCheck, RPC, Telegram
  engine/       ruleEngine + riskScorer (if/threshold murni)
  state/        JSON persist (survive restart PM2)
  scanner.js    orchestrator 1 cycle
  bot.js        command handler
  index.js      cron */5 + polling
config/         default threshold + seed KOL
data/           runtime state (gitignored)
```


## Agent Dorm: API status baca-saja

API ikut berjalan lewat npm start / npm run bot / PM2. Default HTTP:
127.0.0.1:9001. Port ini berbeda dari API ExitBot (9000). Mode --once tetap
hanya scan sekali, tanpa membuka server HTTP. Tidak ada dependency baru.

Konfigurasi opsional di .env:

```env
STATUS_API_ENABLED=true
STATUS_API_HOST=127.0.0.1
STATUS_API_PORT=9001
STATUS_API_KEY=
STATUS_API_DAY_TIMEZONE=Asia/Makassar
STATUS_API_SCAN_STALE_AFTER_SEC=1200
```

- GET /status mengirim envelope agentId=alert untuk Bot Alert di Agent Dorm.
  HTTP 200 juga untuk warn/error/offline; baca field status.
- GET /health memberi HTTP 200 jika status ok, selain itu 503.
- Jika STATUS_API_KEY diisi, kedua endpoint memakai Authorization: Bearer <key>.
- Bind selain loopback ditolak tanpa key. Gunakan SSH tunnel atau reverse proxy
  HTTPS untuk lintas mesin; jangan kirim Bearer key lewat internet HTTP.
- Tidak ada endpoint scan, pause/resume, ubah threshold, kirim Telegram, atau
  transaksi. HTTP GET membaca hasil scan tersimpan dan state proses.
- STATUS_API_ENABLED=false menonaktifkan server. API tidak mengubah threshold,
  perhitungan risiko, jadwal scan, atau daftar pool yang lolos.

Uji tanpa menjalankan scanner atau Telegram:

```bash
npm test
```

Setelah bot dijalankan, coba GET http://127.0.0.1:9001/status. Untuk key,
sertakan header Authorization: Bearer <STATUS_API_KEY>.

Konfigurasi Agent Dorm pada tahap penyambungan nanti:

```env
ALERT_MODE=http
ALERT_URL=http://127.0.0.1:9001
ALERT_API_KEY=
ALERT_POLL_MS=5000
```

### Arti data

- metrics.candidates maksimal 12, diurutkan menurut score menurun. ID memakai
  alamat pool yang stabil, bukan waktu request. events=[] agar Dorm tidak
  membuat coin_found ganda untuk polling kandidat yang sama.
- Skor asli scanner adalah **risiko: kecil lebih baik**. API mempertahankannya
  di riskScore, lalu mengirim score=100-riskScore agar cocok dengan arah skor
  tampilan Dorm. riskCategory tetap kategori asli, bukan jaminan aman.
  safetyAssessmentComplete=false: skor heuristik ini bukan audit rug lengkap.
- passedFilters mencakup semua pool lolos dari scan terakhir, bukan hanya 12
  kartu API. scannedLastCycle adalah jumlah yang di-enrich pada siklus itu.
- scannedToday dihitung dari siklus baru dan disimpan di data/last-scan.json.
  Tidak menebak total harian dari satu scan lama. Sebelum pencatatan dimulai
  nilainya null; hari pertama ditandai dailyCountComplete=false. Counter
  memakai STATUS_API_DAY_TIMEZONE (UTC jika tidak diisi), terpisah dari zona cron.
- lastScanAt adalah waktu scan berhasil. Scan gagal mempertahankan kandidat dan
  waktu sukses sebelumnya, menambahkan lastAttemptAt dan peringatan. Pause
  tetap terlihat, termasuk jika scan manual selesai setelah pengguna menekan pause.
- updatedAt berasal dari heartbeat proses tiap 30 detik; membaca API tidak
  menyegarkannya. Ini mencegah scan 5 menit dianggap offline oleh timeout 120
  detik Dorm. Umur hasil scan tetap diperiksa terpisah (default 1200 detik).
  Sesuaikan STATUS_API_SCAN_STALE_AFTER_SEC bila cron berjalan lebih jarang.
- foundAt bertahan selama pool terus muncul dalam hasil, termasuk sesudah
  restart, karena disimpan bersama compactResult.
- priceUsd/FDV dari DexScreener hanya dipakai bila chain Solana dan base mint
  cocok. Fallback harga DexPaprika hanya untuk sumber token yang tepat.
  **Market cap tidak digunakan sebagai FDV**. Nilai tak diketahui adalah null.
- estFeeAprPct adalah estimasi laju fee pool: fees24h / TVL * 365 * 100,
  bukan janji hasil posisi LP. Hanya dihitung untuk discovery timeframe 24h
  dengan data fee valid; timeframe lain atau data hilang memakai null.
- maxFdvUsd=0 dengan fdvFilterEnabled=false berarti scanner tidak memakai
  batas FDV. Filter lain mengikuti konfigurasi aktif asli, termasuk batas
  holder/risk/usia yang bisa diubah lewat Telegram. Tidak ada rug-check tambahan
  atau ambang baru yang dipaksakan oleh API ini.

Sebelum menghubungkan UI Dorm, tangani nilai null (harga/FDV/APR/lastScanAt),
label arah skor risiko, flag FDV nonaktif, dan kelengkapan counter harian.
UI dummy lama belum membedakan seluruh metadata tersebut. Bot belum
otomatis dijalankan/restart dan konfigurasi Dorm belum diganti ke mode HTTP.

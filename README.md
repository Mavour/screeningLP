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

# Telegram di VPS

## Aktifkan notifikasi

Dari folder `screeningLP` di VPS:

```bash
git pull --ff-only origin main
nano whale-radar/.env
```

Set `RADAR_PUBLIC_TELEGRAM=1`. Worker bisa memakai `TELEGRAM_BOT_TOKEN` dan `ALLOWED_CHAT_ID` dari `.env` utama. Set `RADAR_CHAT_ID` di `whale-radar/.env` jika tujuan alert berbeda. Bot harus sudah bisa mengirim pesan ke chat tujuan.

```bash
pm2 restart whale-radar --update-env
pm2 restart lp-scanner --update-env
curl -fsS -u radar http://127.0.0.1:9011/web/public-status
```

`telegram.state: "enabled"` berarti pengiriman sudah disiapkan. `telegram.lastDeliveredAt` terisi setelah Telegram mengonfirmasi pesan pertama. Alert dipicu pembukaan posisi yang memenuhi ambang lebih dari US$2.000 per wallet per pool setelah verifikasi.

## Buka dashboard melalui IP dan port

Radar tetap mendengarkan di `127.0.0.1:9011`. Gunakan Nginx untuk menyajikan `https://VPS_IP:9443/web`. Gunakan port 9443 yang kosong dan izinkan TCP 9443 di firewall VPS serta firewall cloud. Ganti `VPS_IP` dengan alamat publik VPS pada contoh berikut.

Jika Nginx dan Certbot 5.4+ sudah terpasang, jalankan `bash whale-radar/docs/setup-ip-https.sh VPS_IP` dari folder `screeningLP`. Skrip menguji konfigurasi Nginx, meminta sertifikat, dan memeriksa respons HTTPS. Panduan manual di bawah bisa dipakai jika sudah ada konfigurasi Nginx untuk IP yang sama.

### 1. Siapkan validasi sertifikat

Gunakan [Certbot 5.4 atau lebih baru](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) dan Nginx. Buat direktori challenge di VPS:

```bash
sudo install -d -m 755 /var/www/radar-acme
```

Tambahkan konfigurasi berikut di `/etc/nginx/conf.d/whale-radar-acme.conf`. Jika konfigurasi yang aktif sudah punya blok port 80 untuk IP ini, tambahkan lokasi challenge di blok itu.

```nginx
server {
    listen 80;
    server_name VPS_IP;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/radar-acme;
    }

    location / { return 404; }
}
```

Izinkan TCP 80 ke Nginx untuk validasi otomatis. Jalankan:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/radar-acme \
  --preferred-profile shortlived --ip-address VPS_IP --cert-name whale-radar-ip \
  --deploy-hook 'nginx -t && systemctl reload nginx'
```

### 2. Aktifkan HTTPS Radar

Setelah sertifikat terbit, simpan blok ini di `/etc/nginx/conf.d/whale-radar-ip.conf`:

```nginx
server {
    listen 9443 ssl;
    server_name VPS_IP;
    ssl_certificate /etc/letsencrypt/live/whale-radar-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whale-radar-ip/privkey.pem;

    location ~ ^/web(?:/|$) {
        proxy_pass http://127.0.0.1:9011;
        proxy_set_header Authorization $http_authorization;
    }

    location / { return 404; }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --cert-name whale-radar-ip --dry-run
systemctl list-timers --all | grep -i certbot
curl -fsS -u radar https://VPS_IP:9443/web/public-status
```

Sertifikat IP berumur sekitar enam hari. Pastikan timer renewal aktif dan biarkan lokasi challenge di port 80 tersedia.

Terakhir, set `RADAR_PUBLIC_URL=https://VPS_IP:9443` di `whale-radar/.env`. Restart `whale-radar` agar tombol di alert memakai URL baru. Bot scanner membaca URL saat perintah `/web` dipakai. Setelah kedua proses berjalan, jalankan `pm2 save`.

#!/usr/bin/env bash
set -euo pipefail

ip=${1:-}
port=${2:-9443}
if [[ ! $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || ! $port =~ ^[1-9][0-9]{3,4}$ ]] ||
    (( port > 65535 || port == 9011 )); then
  echo "Usage: bash $0 PUBLIC_IPV4 [HTTPS_PORT]" >&2
  exit 1
fi
IFS=. read -r -a octets <<< "$ip"
for octet in "${octets[@]}"; do
  if (( 10#$octet > 255 )); then
    echo "Invalid IPv4 address" >&2
    exit 1
  fi
done
for program in nginx certbot curl; do
  command -v "$program" >/dev/null || { echo "Missing prerequisite: $program" >&2; exit 1; }
done
if [[ $(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:9011/web/public-status) != 401 ]]; then
  echo "Expected the authenticated Radar dashboard on 127.0.0.1:9011. Check PM2 first." >&2
  exit 1
fi
version=$(certbot --version)
if [[ ! $version =~ ([0-9]+)\.([0-9]+) ]] || (( BASH_REMATCH[1] < 5 || (BASH_REMATCH[1] == 5 && BASH_REMATCH[2] < 4) )); then
  echo "Certbot 5.4+ is required for IP certificates with webroot validation." >&2
  exit 1
fi

root=/var/www/radar-acme
challenge=/etc/nginx/conf.d/whale-radar-acme.conf
https=/etc/nginx/conf.d/whale-radar-ip.conf
cert=/etc/letsencrypt/live/whale-radar-ip
sudo nginx -t
sudo install -d -m 755 "$root"

install_site() {
  local path=$1
  if sudo test -e "$path"; then
    echo "Keeping existing $path"
    cat >/dev/null
    return
  fi
  sudo tee "$path" >/dev/null
  if ! sudo nginx -t; then
    sudo rm -f -- "$path"
    return 1
  fi
  sudo systemctl reload nginx
}

if ! sudo test -e "$challenge" && sudo nginx -T 2>/dev/null | awk -v ip="$ip" '
  $1 == "server_name" {
    for (i=2;i<=NF;i++) { sub(/;$/, "", $i); if ($i==ip) found=1 }
  }
  END { exit !found }'; then
  echo "Nginx already has a server block for $ip. Follow the guide to add the ACME location to that block." >&2
  exit 1
fi

install_site "$challenge" <<EOF
server {
    listen 80;
    server_name $ip;
    location ^~ /.well-known/acme-challenge/ { root $root; }
    location / { return 404; }
}
EOF

sudo certbot certonly --webroot -w "$root" --preferred-profile shortlived \
  --ip-address "$ip" --cert-name whale-radar-ip --keep-until-expiring \
  --deploy-hook 'nginx -t && systemctl reload nginx'

install_site "$https" <<EOF
server {
    listen $port ssl;
    server_name $ip;
    ssl_certificate $cert/fullchain.pem;
    ssl_certificate_key $cert/privkey.pem;
    location ~ ^/web(?:/|\$) {
        proxy_pass http://127.0.0.1:9011;
        proxy_set_header Authorization \$http_authorization;
    }
    location / { return 404; }
}
EOF

url="https://$ip:$port"
status=$(curl -sS --max-time 8 --resolve "$ip:$port:127.0.0.1" -o /dev/null -w '%{http_code}' "$url/web")
if [[ $status != 401 ]]; then
  echo "Expected Radar login challenge over HTTPS, got HTTP $status" >&2
  exit 1
fi
echo "Verified HTTPS and Radar authentication on the VPS."
echo "Set RADAR_PUBLIC_URL=$url in whale-radar/.env and restart whale-radar."

#!/usr/bin/env bash
set -euo pipefail

umask 077
base=/etc/mihomo
url_file="$base/subscription.url"
config="$base/config.yaml"
previous="$base/config.yaml.previous"
tmp=$(mktemp "$base/.subscription.XXXXXX.yaml")
trap 'rm -f "$tmp"' EXIT

url=$(sed -n '1p' "$url_file")
test -n "$url"

# The subscription endpoint requires Clash Verge's request identity. Keep the
# URL and response out of logs because the URL contains subscription secrets.
curl --fail --silent --show-error --location \
  --proxy http://127.0.0.1:7890 \
  --user-agent 'clash-verge/v2.4.8' \
  --max-time 60 \
  --output "$tmp" "$url"

grep -q '^proxies:' "$tmp"

# Keep the server-side safety boundary even if the subscription changes local
# desktop settings. The runner only needs a loopback HTTP proxy.
sed -i -E \
  -e 's/^port: .*/port: 7890/' \
  -e 's/^mixed-port: .*/mixed-port: 7890/' \
  -e 's/^allow-lan: .*/allow-lan: false/' \
  -e 's/^bind-address: .*/bind-address: 127.0.0.1/' \
  -e 's/^external-controller: .*/external-controller: 127.0.0.1:9097/' \
  -e 's#^external-controller-unix: .*#external-controller-unix: /run/mihomo/mihomo.sock#' \
  -e "s/^external-controller-tls: .*/external-controller-tls: ''/" \
  -e 's/^  listen: :53$/  listen: 127.0.0.1:1053/' \
  "$tmp"

secret=$(openssl rand -hex 16)
sed -i -E "s/^secret: .*/secret: $secret/" "$tmp"

/usr/local/bin/mihomo -t -d "$base" -f "$tmp" >/dev/null
install -o root -g root -m 0600 "$config" "$previous"
mv -f "$tmp" "$config"

rollback() {
  install -o root -g root -m 0600 "$previous" "$config"
  systemctl restart mihomo.service || true
}

if ! systemctl restart mihomo.service; then
  rollback
  exit 1
fi

proxy_healthcheck() {
  for _ in $(seq 1 15); do
    if curl --fail --silent --location \
      --proxy http://127.0.0.1:7890 \
      --max-time 10 \
      --output /dev/null \
      https://api.github.com/repos/TaurusGGBOY/TaurusGGBOY.github.io; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! proxy_healthcheck; then
  rollback
  exit 1
fi

rm -f "$previous"

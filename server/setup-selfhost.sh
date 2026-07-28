#!/usr/bin/env bash
# Install and start the Athena self-hosted backend + Cloudflare Tunnel.
# Run as root:  bash server/setup-selfhost.sh
set -euo pipefail

REPO="/root/athena"
ENV_FILE="/etc/athena/athena.env"
NODE_BIN="$(command -v node || echo /usr/local/lib/nodejs/current/bin/node)"

echo "==> checking prerequisites"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
[ -d "$REPO" ] || { echo "missing $REPO"; exit 1; }
"$NODE_BIN" --version | grep -qE 'v(2[2-9]|[3-9][0-9])' || { echo "Node 22+ required, found $($NODE_BIN --version)"; exit 1; }

echo "==> locking down the env file (it holds the DB password)"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

echo "==> reloading postgres so the loopback pg_hba rule takes effect"
# RHEL's default pg_hba uses ident auth for 127.0.0.1, which rejects a password
# login. A scram rule was inserted ABOVE it (first match wins) but Postgres only
# reads pg_hba on reload, and pg_reload_conf() is superuser-only.
if grep -q 'athena.*127.0.0.1/32.*scram' /var/lib/pgsql/data/pg_hba.conf 2>/dev/null; then
  systemctl reload postgresql
else
  echo "  WARNING: no loopback scram rule found in pg_hba.conf — the backend will"
  echo "  fail with 'Ident authentication failed'. Add above the ident lines:"
  echo "    host  athena  athena  127.0.0.1/32  scram-sha-256"
fi

echo "==> verifying the database is reachable over loopback"
cd "$REPO"
set -a; . "$ENV_FILE"; set +a
"$NODE_BIN" -e "
import('pg').then(async ({default:pg})=>{
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});
  try{ await c.connect(); await c.query('SELECT 1'); console.log('  postgres OK'); await c.end(); }
  catch(e){ console.error('  postgres FAILED:', e.message); process.exit(1); }
});" || exit 1

echo "==> installing node dependencies"
npm install --omit=dev --silent

echo "==> pointing the service at $NODE_BIN"
sed -i "s|^ExecStart=.*node server/index.js|ExecStart=$NODE_BIN server/index.js|" /etc/systemd/system/athena.service

echo "==> installing cloudflared (if absent)"
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  CF_ARCH=amd64 ;;
    aarch64) CF_ARCH=arm64 ;;
    *) echo "unsupported arch $ARCH — install cloudflared manually"; exit 1 ;;
  esac
  curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version

echo "==> enabling services"
systemctl daemon-reload
systemctl enable --now athena.service
sleep 3
systemctl enable --now cloudflared-athena.service
sleep 6

echo
echo "==> athena status"
systemctl --no-pager --lines=8 status athena.service || true

echo
echo "==> local health check"
curl -fsS http://127.0.0.1:8787/api/health | head -c 200 || echo "backend not answering yet"
echo

BACKEND_URL="https://your-domain.example.com"

echo
echo "==> checking the public hostname"
if getent hosts your-domain.example.com >/dev/null 2>&1; then
  echo "  DNS resolves"
else
  echo "  DNS DOES NOT RESOLVE YET."
  echo "  Add this CNAME in Cloudflare (your-parent-domain.com -> DNS), proxied:"
  echo "    athena  CNAME  YOUR_TUNNEL_ID.cfargotunnel.com"
fi
sleep 5
echo "==> end-to-end check through the tunnel"
curl -fsS --max-time 20 "$BACKEND_URL/api/health" | head -c 200 \
  || echo "  not answering yet — give the tunnel a few seconds, then: curl $BACKEND_URL/api/health"
echo

cat <<NOTE

Next:
  1. Open the website and go to Settings -> Backend.
     Paste: $BACKEND_URL   then "Use this backend" and sign in again.
     (Sessions are per-backend, so the old one does not carry over.)

  2. Backups run every BACKUP_INTERVAL_HOURS (currently $(grep -E '^BACKUP_INTERVAL_HOURS' /etc/athena/athena.env | cut -d= -f2)) to your Telegram DM,
     through the local Bot API server so they are not split at 50MB.
     Force one now:
       set -a; . /etc/athena/athena.env; set +a; node server/backup-now.js

  3. Once the backend is confirmed working, close off external database access:
       sed -i '/2.25.134.206\/32/d' /var/lib/pgsql/data/pg_hba.conf
       sed -i "s/^listen_addresses = '\*'/listen_addresses = 'localhost'/" /var/lib/pgsql/data/postgresql.conf
       systemctl restart postgresql

Logs:
  journalctl -u athena -f
  journalctl -u cloudflared-athena -f
NOTE

#!/usr/bin/env bash
# One-command install (and update) of the Sirix survey app on a Debian/Ubuntu server.
#
# Run as root (or with sudo). Examples:
#
#   # Install with automatic HTTPS on a domain that already points to this server:
#   curl -fsSL https://raw.githubusercontent.com/dancyrsirix/Sirix-Survey-Employee-Appreciation/claude/anonymous-eval-app-oeiiy2/deploy/install.sh \
#     | sudo DOMAIN=sondage.example.com bash
#
#   # Install without a domain (app listens on http://SERVER-IP:3000, put your own proxy in front):
#   curl -fsSL .../deploy/install.sh | sudo bash
#
#   # Private repository: give a URL that includes a GitHub token
#   curl -fsSL .../deploy/install.sh | sudo REPO_URL=https://TOKEN@github.com/dancyrsirix/Sirix-Survey-Employee-Appreciation.git DOMAIN=... bash
#
# Re-running the script updates the app to the latest commit of the branch and restarts it. Data is kept.
#
# Settings (environment variables, all optional):
#   REPO_URL   git URL to clone              default: https://github.com/dancyrsirix/Sirix-Survey-Employee-Appreciation.git
#   BRANCH     branch to deploy              default: claude/anonymous-eval-app-oeiiy2
#   APP_DIR    where the code lives          default: /opt/sirix-survey
#   DATA_DIR   where the database lives      default: /var/lib/sirix-survey
#   PORT       local port of the app         default: 3000
#   DOMAIN     if set, installs Caddy and serves https://DOMAIN with an automatic certificate
#   ADMIN_USER / ADMIN_PASSWORD   optional; if unset you create the admin account on the first visit to /admin

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dancyrsirix/Sirix-Survey-Employee-Appreciation.git}"
BRANCH="${BRANCH:-claude/anonymous-eval-app-oeiiy2}"
APP_DIR="${APP_DIR:-/opt/sirix-survey}"
DATA_DIR="${DATA_DIR:-/var/lib/sirix-survey}"
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
SERVICE="sirix-survey"
RUN_USER="sirix"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this script as root (or with sudo)."
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu (apt-get). For another system, install Node 22, clone the repo and run 'npm start' behind your own proxy; see README.md."
command -v systemctl >/dev/null 2>&1 || die "systemd is required to run the app as a service."

export DEBIAN_FRONTEND=noninteractive

log "Installing base packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg >/dev/null

# ---- Node.js 22+ ----
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -ge 22 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v) ready"

# ---- system user and folders ----
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "Creating system user $RUN_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi
mkdir -p "$DATA_DIR"
chown "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---- code ----
if [ -d "$APP_DIR/.git" ]; then
  log "Updating code in $APP_DIR (branch $BRANCH)"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL (branch $BRANCH) into $APP_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
    || die "Clone failed. If the repository is private, pass REPO_URL=https://TOKEN@github.com/... (GitHub personal access token with repo read access)."
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ---- environment file (kept across updates) ----
ENV_FILE="/etc/${SERVICE}.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE"
  {
    echo "PORT=$PORT"
    echo "HOST=127.0.0.1"
    echo "DATA_DIR=$DATA_DIR"
    echo "NODE_ENV=production"
    [ -n "${ADMIN_USER:-}" ] && echo "ADMIN_USER=$ADMIN_USER"
    [ -n "${ADMIN_PASSWORD:-}" ] && echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    true
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# If no domain, listen on all interfaces so the app is reachable on http://SERVER-IP:PORT
if [ -z "$DOMAIN" ]; then sed -i 's/^HOST=.*/HOST=0.0.0.0/' "$ENV_FILE"; else sed -i 's/^HOST=.*/HOST=127.0.0.1/' "$ENV_FILE"; fi

# ---- systemd service ----
log "Installing systemd service $SERVICE"
cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=Sirix employee appreciation survey
After=network.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
sleep 1
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "The service did not start. See the log above."; }

# ---- HTTPS with Caddy (optional) ----
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    log "Installing Caddy (automatic HTTPS)"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  log "Configuring Caddy for https://$DOMAIN"
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
  systemctl enable --quiet caddy
  systemctl restart caddy
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  fi
fi

log "Done"
echo
if [ -n "$DOMAIN" ]; then
  echo "  Employees:  https://$DOMAIN/"
  echo "  Admin:      https://$DOMAIN/admin   (first visit: create the admin account)"
  echo "  The certificate is issued automatically once DNS for $DOMAIN points to this server (ports 80 and 443 open)."
else
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "  Employees:  http://${ip:-SERVER-IP}:$PORT/"
  echo "  Admin:      http://${ip:-SERVER-IP}:$PORT/admin   (first visit: create the admin account)"
  echo "  Tip: re-run with DOMAIN=your.domain.com to get HTTPS automatically."
fi
echo
echo "  Database:   $DATA_DIR/survey.db   (back this file up)"
echo "  Logs:       journalctl -u $SERVICE -f"
echo "  Update:     re-run this script, or: sudo bash $APP_DIR/deploy/install.sh"

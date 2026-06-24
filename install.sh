#!/usr/bin/env bash
set -Eeuo pipefail

FLEET_REPOSITORY="${WDTT_FLEET_REPOSITORY:-lebrit/wdtt-fleet-manager}"
FLEET_BRANCH="${WDTT_FLEET_BRANCH:-main}"
INSTALL_DIR="/opt/wdtt-fleet-manager"
CONFIG_DIR="/etc/wdtt-fleet-manager"
AUTH_FILE="/etc/nginx/wdtt-fleet-manager.htpasswd"
STATE_DIR="/var/lib/wdtt-fleet-manager"
LOG_FILE="/var/log/wdtt-fleet-manager-install.log"
SERVICE_NAME="wdtt-fleet-manager.service"
NGINX_FILE="/etc/nginx/conf.d/wdtt-fleet-manager.conf"
PANEL_USER="${PANEL_USER:-admin}"
PANEL_PASSWORD="${PANEL_PASSWORD:-}"
PANEL_HOST="${PANEL_HOST:-}"
PANEL_PATH="${PANEL_PATH:-}"
AGENT_PATH="${AGENT_PATH:-}"
PANEL_HTTPS_PORT="${PANEL_HTTPS_PORT:-8444}"
PANEL_LISTEN_PORT="${PANEL_LISTEN_PORT:-8788}"
PANEL_EMAIL="${PANEL_EMAIL:-}"
NON_INTERACTIVE=0
TLS_MODE=""
CERTIFICATE_PATH=""
PRIVATE_KEY_PATH=""

log() { printf '[wdtt-fleet] %s\n' "$*" | tee -a "$LOG_FILE"; }
die() { log "ОШИБКА: $*"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }
random_token() {
  local token length="${1:-20}"
  token="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-')"
  printf '%s' "${token:0:length}"
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Запустите установщик с sudo: curl -fsSL …/bootstrap.sh | sudo bash"
  touch "$LOG_FILE"
}

detect_os() {
  [ -r /etc/os-release ] || die "Не найден /etc/os-release"
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu|linuxmint|pop) PACKAGE_MANAGER="apt" ;;
    fedora|rhel|centos|rocky|almalinux) PACKAGE_MANAGER="dnf" ;;
    *) die "Поддерживаются Debian/Ubuntu и Fedora/RHEL-подобные системы" ;;
  esac
}

install_packages() {
  log "Установка системных зависимостей"
  if [ "$PACKAGE_MANAGER" = "apt" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >>"$LOG_FILE" 2>&1
    apt-get install -y -qq ca-certificates curl git nginx openssl python3 python3-venv apache2-utils sudo >>"$LOG_FILE" 2>&1
  else
    dnf install -y ca-certificates curl git nginx openssl python3 httpd-tools sudo >>"$LOG_FILE" 2>&1
  fi
}

install_node() {
  local major=""
  if command_exists node; then major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"; fi
  if [ -n "$major" ] && [ "$major" -ge 22 ]; then return; fi
  log "Установка Node.js 22"
  if [ "$PACKAGE_MANAGER" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >>"$LOG_FILE" 2>&1
    apt-get install -y -qq nodejs >>"$LOG_FILE" 2>&1
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >>"$LOG_FILE" 2>&1
    dnf install -y nodejs >>"$LOG_FILE" 2>&1
  fi
  command_exists node || die "Не удалось установить Node.js"
}

parse_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --domain|--ip) PANEL_HOST="$2"; shift 2 ;;
      --user) PANEL_USER="$2"; shift 2 ;;
      --password) PANEL_PASSWORD="$2"; shift 2 ;;
      --https-port) PANEL_HTTPS_PORT="$2"; shift 2 ;;
      --path) PANEL_PATH="$2"; shift 2 ;;
      --email) PANEL_EMAIL="$2"; shift 2 ;;
      --non-interactive) NON_INTERACTIVE=1; shift ;;
      *) die "Неизвестный параметр: $1" ;;
    esac
  done
}

suggest_host() {
  curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true
}

read_or_default() {
  local prompt="$1" default="$2" answer
  if [ "$NON_INTERACTIVE" = "1" ]; then printf '%s' "$default"; return; fi
  [ -r /dev/tty ] && [ -w /dev/tty ] || die "Для интерактивной установки нужен терминал; используйте --non-interactive"
  read -r -p "$prompt [$default]: " answer </dev/tty
  printf '%s' "${answer:-$default}"
}

validate_configuration() {
  if [ -z "$PANEL_HOST" ]; then PANEL_HOST="$(read_or_default 'Домен или публичный IPv4' "$(suggest_host)")"; fi
  [ -n "$PANEL_HOST" ] || die "Укажите домен или публичный IPv4 через --domain или --ip"
  [[ "$PANEL_HOST" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "Недопустимый домен или IP"
  if [ -z "$PANEL_PASSWORD" ] && [ "$NON_INTERACTIVE" != "1" ]; then
    [ -r /dev/tty ] && [ -w /dev/tty ] || die "Для ввода пароля нужен терминал; используйте --password"
    read -r -s -p "Пароль веб-панели (от 12 символов): " PANEL_PASSWORD </dev/tty
    printf '\n'
  fi
  [ "${#PANEL_PASSWORD}" -ge 12 ] || die "Укажите пароль длиной не менее 12 символов через --password"
  [[ "$PANEL_USER" =~ ^[A-Za-z0-9_.@-]{1,64}$ ]] || die "Недопустимый логин"
  [[ "$PANEL_HTTPS_PORT" =~ ^[0-9]{2,5}$ ]] && [ "$PANEL_HTTPS_PORT" -le 65535 ] || die "Недопустимый HTTPS-порт"
  if [ -z "$PANEL_PATH" ]; then PANEL_PATH="/fleet-$(random_token 12)/"; fi
  [[ "$PANEL_PATH" =~ ^/[A-Za-z0-9_-]{8,64}/$ ]] || die "Путь должен выглядеть как /secret-path/"
  if [ -z "$AGENT_PATH" ]; then AGENT_PATH="/fleet-agent-$(random_token 12)/"; fi
  [[ "$AGENT_PATH" =~ ^/[A-Za-z0-9_-]{8,64}/$ ]] || die "Путь агента должен выглядеть как /secret-path/"
}

install_files() {
  local ref="${1:-$FLEET_BRANCH}"
  log "Получение файлов $FLEET_REPOSITORY@$ref"
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --depth=1 --tags origin "$ref" >>"$LOG_FILE" 2>&1
    git -C "$INSTALL_DIR" reset --hard FETCH_HEAD >>"$LOG_FILE" 2>&1
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth=1 --branch "$ref" "https://github.com/$FLEET_REPOSITORY.git" "$INSTALL_DIR" >>"$LOG_FILE" 2>&1
  fi
  mkdir -p "$CONFIG_DIR" "$STATE_DIR/acme"
  chmod 0700 "$CONFIG_DIR"
}

ensure_service_user() {
  getent group wdtt-fleet >/dev/null || groupadd --system wdtt-fleet
  id -u wdtt-fleet >/dev/null 2>&1 || useradd --system --gid wdtt-fleet --home-dir "$STATE_DIR" --shell /usr/sbin/nologin wdtt-fleet
  chown -R wdtt-fleet:wdtt-fleet "$STATE_DIR"
  chown -R root:root "$INSTALL_DIR"
}

write_config() {
  umask 027
  cat > "$CONFIG_DIR/app.env" <<EOF
PORT=$PANEL_LISTEN_PORT
HOST=127.0.0.1
TRUST_PROXY_ADMIN=true
ADMIN_API_TOKEN=
STATE_FILE=$STATE_DIR/state.json
AGENT_ENDPOINT=https://$PANEL_HOST:$PANEL_HTTPS_PORT$AGENT_PATH
EOF
  chown root:wdtt-fleet "$CONFIG_DIR/app.env"
  chmod 0640 "$CONFIG_DIR/app.env"
  htpasswd -bcB "$AUTH_FILE" "$PANEL_USER" "$PANEL_PASSWORD" >>"$LOG_FILE" 2>&1
  chown root:root "$AUTH_FILE"
  chmod 0644 "$AUTH_FILE"
  save_panel_config
}

migrate_auth_file() {
  if [ -r "$CONFIG_DIR/htpasswd" ]; then
    install -m 0644 -o root -g root "$CONFIG_DIR/htpasswd" "$AUTH_FILE"
    rm -f "$CONFIG_DIR/htpasswd"
  fi
  [ -r "$AUTH_FILE" ] || die "Не найден файл Basic Auth; запустите смену пароля панели"
}

save_panel_config() {
  cat > "$CONFIG_DIR/panel.conf" <<EOF
PANEL_HOST='$PANEL_HOST'
PANEL_PATH='$PANEL_PATH'
AGENT_PATH='$AGENT_PATH'
PANEL_HTTPS_PORT='$PANEL_HTTPS_PORT'
PANEL_LISTEN_PORT='$PANEL_LISTEN_PORT'
PANEL_EMAIL='$PANEL_EMAIL'
PANEL_USER='$PANEL_USER'
TLS_MODE='$TLS_MODE'
CERTIFICATE_PATH='$CERTIFICATE_PATH'
PRIVATE_KEY_PATH='$PRIVATE_KEY_PATH'
EOF
  chmod 0600 "$CONFIG_DIR/panel.conf"
}

load_config() {
  [ -r "$CONFIG_DIR/panel.conf" ] || die "Панель ещё не установлена"
  # shellcheck disable=SC1090
  . "$CONFIG_DIR/panel.conf"
}

write_service() {
  cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=WDTT Fleet Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wdtt-fleet
Group=wdtt-fleet
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$CONFIG_DIR/app.env
ExecStart=/usr/bin/node $INSTALL_DIR/src/server.js
Restart=on-failure
RestartSec=3
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$STATE_DIR
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >>"$LOG_FILE" 2>&1
}

install_certbot() {
  if [ ! -x "$INSTALL_DIR/certbot/bin/certbot" ]; then
    python3 -m venv "$INSTALL_DIR/certbot" >>"$LOG_FILE" 2>&1
    "$INSTALL_DIR/certbot/bin/pip" install --upgrade pip >>"$LOG_FILE" 2>&1
    "$INSTALL_DIR/certbot/bin/pip" install 'certbot>=5.4,<6' >>"$LOG_FILE" 2>&1
  fi
}

write_acme_nginx() {
  cat > "$NGINX_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $PANEL_HOST;
    location ^~ /.well-known/acme-challenge/ { root $STATE_DIR/acme; }
    location / { return 404; }
}
EOF
  nginx -t >>"$LOG_FILE" 2>&1 && systemctl enable --now nginx >>"$LOG_FILE" 2>&1 && systemctl reload nginx >>"$LOG_FILE" 2>&1
}

request_certificate() {
  TLS_MODE="self-signed"
  write_acme_nginx || { log "Nginx не принял временную ACME-конфигурацию"; return 1; }
  install_certbot || return 1
  local -a options=(certonly --non-interactive --agree-tos --webroot --webroot-path "$STATE_DIR/acme")
  if [ -n "$PANEL_EMAIL" ]; then options+=(--email "$PANEL_EMAIL"); else options+=(--register-unsafely-without-email); fi
  if [[ "$PANEL_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    options+=(--preferred-profile shortlived --ip-address "$PANEL_HOST" --cert-name "$PANEL_HOST")
  else
    options+=(-d "$PANEL_HOST")
  fi
  if "$INSTALL_DIR/certbot/bin/certbot" "${options[@]}" >>"$LOG_FILE" 2>&1; then
    CERTIFICATE_PATH="/etc/letsencrypt/live/$PANEL_HOST/fullchain.pem"
    PRIVATE_KEY_PATH="/etc/letsencrypt/live/$PANEL_HOST/privkey.pem"
    if [ -r "$CERTIFICATE_PATH" ] && [ -r "$PRIVATE_KEY_PATH" ]; then TLS_MODE="letsencrypt"; return 0; fi
  fi
  return 1
}

create_self_signed_certificate() {
  mkdir -p "$CONFIG_DIR/tls"
  CERTIFICATE_PATH="$CONFIG_DIR/tls/fullchain.pem"
  PRIVATE_KEY_PATH="$CONFIG_DIR/tls/privkey.pem"
  local san="DNS:$PANEL_HOST"
  [[ "$PANEL_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && san="IP:$PANEL_HOST"
  openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes -keyout "$PRIVATE_KEY_PATH" -out "$CERTIFICATE_PATH" -subj "/CN=$PANEL_HOST" -addext "subjectAltName=$san" >>"$LOG_FILE" 2>&1
  chmod 0600 "$PRIVATE_KEY_PATH"
  TLS_MODE="self-signed"
}

write_nginx() {
  [ -n "$CERTIFICATE_PATH" ] || die "Не задан сертификат"
  cat > "$NGINX_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $PANEL_HOST;
    location ^~ /.well-known/acme-challenge/ { root $STATE_DIR/acme; }
    location / { return 302 https://$PANEL_HOST:$PANEL_HTTPS_PORT$PANEL_PATH; }
}
server {
    listen $PANEL_HTTPS_PORT ssl;
    listen [::]:$PANEL_HTTPS_PORT ssl;
    server_name $PANEL_HOST;
    ssl_certificate $CERTIFICATE_PATH;
    ssl_certificate_key $PRIVATE_KEY_PATH;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;
    location = ${PANEL_PATH%/} { return 302 $PANEL_PATH; }
    location ^~ $PANEL_PATH {
        auth_basic "WDTT Fleet Manager";
        auth_basic_user_file $AUTH_FILE;
        proxy_pass http://127.0.0.1:$PANEL_LISTEN_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-WDTT-Fleet-Operator \$remote_user;
        proxy_set_header Connection "";
        proxy_read_timeout 75s;
        client_max_body_size 1m;
    }
    location = ${AGENT_PATH%/} { return 404; }
    location ^~ $AGENT_PATH {
        proxy_pass http://127.0.0.1:$PANEL_LISTEN_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-WDTT-Fleet-Operator "";
        proxy_set_header Connection "";
        proxy_read_timeout 75s;
        client_max_body_size 1m;
    }
    location / { return 404; }
}
EOF
  nginx -t >>"$LOG_FILE" 2>&1 || die "Ошибка конфигурации Nginx; см. $LOG_FILE"
  systemctl enable --now nginx >>"$LOG_FILE" 2>&1
  systemctl reload nginx >>"$LOG_FILE" 2>&1
}

open_firewall() {
  if command_exists ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp comment 'WDTT Fleet ACME' >/dev/null || true
    ufw allow "$PANEL_HTTPS_PORT/tcp" comment 'WDTT Fleet HTTPS' >/dev/null || true
  elif command_exists firewall-cmd && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-service=http >/dev/null || true
    firewall-cmd --permanent --add-port="$PANEL_HTTPS_PORT/tcp" >/dev/null || true
    firewall-cmd --reload >/dev/null || true
  fi
}

write_renew_timer() {
  cat > /etc/systemd/system/wdtt-fleet-manager-cert-renew.service <<EOF
[Unit]
Description=Renew WDTT Fleet Manager certificate
[Service]
Type=oneshot
ExecStart=/bin/bash $INSTALL_DIR/install.sh renew-cert
EOF
  cat > /etc/systemd/system/wdtt-fleet-manager-cert-renew.timer <<'EOF'
[Unit]
Description=Periodic WDTT Fleet Manager certificate check
[Timer]
OnBootSec=15min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now wdtt-fleet-manager-cert-renew.timer >>"$LOG_FILE" 2>&1
}

write_wrappers() {
  for name in wdtt-fleet wdtt-fleet-update wdtt-fleet-status wdtt-fleet-uninstall; do
    case "$name" in
      wdtt-fleet) action="menu" ;; wdtt-fleet-update) action="update" ;; wdtt-fleet-status) action="status" ;; wdtt-fleet-uninstall) action="uninstall" ;;
    esac
    cat > "/usr/local/sbin/$name" <<EOF
#!/usr/bin/env bash
exec sudo /bin/bash $INSTALL_DIR/install.sh $action "\$@"
EOF
    chmod 0755 "/usr/local/sbin/$name"
  done
}

show_status() {
  load_config
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  printf 'URL: https://%s:%s%s\n' "$PANEL_HOST" "$PANEL_HTTPS_PORT" "$PANEL_PATH"
  printf 'TLS: %s\n' "${TLS_MODE:-не определён}"
}

install_panel() {
  require_root; detect_os; install_packages; install_node; validate_configuration; install_files; ensure_service_user; write_config; write_service; open_firewall
  if request_certificate; then log "Получен сертификат Let's Encrypt"; else log "Публичный сертификат не получен, используется self-signed"; create_self_signed_certificate; fi
  save_panel_config; write_nginx; open_firewall; write_renew_timer; write_wrappers
  log "Установка завершена"
  printf 'URL: https://%s:%s%s\nАдрес агента: https://%s:%s%s\nЛогин: %s\nПароль задан вами и не сохраняется в логе.\n' "$PANEL_HOST" "$PANEL_HTTPS_PORT" "$PANEL_PATH" "$PANEL_HOST" "$PANEL_HTTPS_PORT" "$AGENT_PATH" "$PANEL_USER"
  printf 'Панель доступна извне по HTTPS; Node.js остаётся за Nginx на loopback.\n'
}

update_panel() {
  require_root; load_config; log "Начато обновление панели"; detect_os; install_node; install_files "$FLEET_BRANCH"; ensure_service_user; migrate_auth_file; write_service; write_nginx; systemctl restart "$SERVICE_NAME"; log "Панель обновлена"
}

renew_certificates() {
  require_root; load_config
  local previous_tls_mode="$TLS_MODE"
  if request_certificate; then
    save_panel_config; write_nginx; log "Сертификат обновлён"; return
  fi
  TLS_MODE="$previous_tls_mode"
  if [ "$TLS_MODE" = "self-signed" ] && { [ ! -r "$CERTIFICATE_PATH" ] || ! openssl x509 -checkend 2592000 -noout -in "$CERTIFICATE_PATH" >/dev/null 2>&1; }; then
    create_self_signed_certificate; save_panel_config; write_nginx; log "Self-signed сертификат обновлён"; return
  fi
  write_nginx || true
  log "Сертификат не обновлён; прежняя конфигурация восстановлена, подробности в $LOG_FILE"
  return 1
}

change_password() {
  require_root; load_config
  if [ -z "$PANEL_PASSWORD" ]; then
    [ -r /dev/tty ] && [ -w /dev/tty ] || die "Для ввода пароля нужен терминал; используйте --password"
    read -r -s -p "Новый пароль веб-панели: " PANEL_PASSWORD </dev/tty
    printf '\n'
  fi
  [ "${#PANEL_PASSWORD}" -ge 12 ] || die "Пароль должен содержать не менее 12 символов"
  htpasswd -bcB "$AUTH_FILE" "$PANEL_USER" "$PANEL_PASSWORD" >>"$LOG_FILE" 2>&1
  chown root:root "$AUTH_FILE"; chmod 0644 "$AUTH_FILE"
  log "Пароль веб-панели изменён"
}

restart_panel() {
  require_root
  systemctl restart "$SERVICE_NAME"
  log "Сервис перезапущен"
}

show_logs() {
  journalctl -u "$SERVICE_NAME" -n 120 --no-pager || true
}

show_certificate_status() {
  load_config
  printf 'Режим TLS: %s\n' "$TLS_MODE"
  [ -r "$CERTIFICATE_PATH" ] || die "Файл сертификата не найден"
  openssl x509 -noout -issuer -subject -enddate -in "$CERTIFICATE_PATH"
}

change_path() {
  require_root; load_config
  local requested=""
  [ -r /dev/tty ] && [ -w /dev/tty ] || die "Для изменения URL нужен терминал"
  read -r -p "Новый секретный путь (Enter — сгенерировать): " requested </dev/tty
  PANEL_PATH="${requested:-/fleet-$(random_token 12)/}"
  [[ "$PANEL_PATH" =~ ^/[A-Za-z0-9_-]{8,64}/$ ]] || die "Путь должен выглядеть как /secret-path/"
  save_panel_config; write_nginx
  printf 'Новый адрес: https://%s:%s%s\n' "$PANEL_HOST" "$PANEL_HTTPS_PORT" "$PANEL_PATH"
}

rollback_panel() {
  require_root; load_config
  local version="${1:-}"
  if [ -z "$version" ]; then
    printf 'Доступные теги:\n'
    git ls-remote --tags --refs "https://github.com/$FLEET_REPOSITORY.git" | sed 's#.*refs/tags/##' | tail -n 20
    [ -r /dev/tty ] && [ -w /dev/tty ] || die "Для выбора версии нужен терминал"
    read -r -p 'Введите тег для отката: ' version </dev/tty
  fi
  [[ "$version" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || die "Недопустимый тег"
  install_files "$version"; ensure_service_user; migrate_auth_file; write_service; write_nginx; systemctl restart "$SERVICE_NAME"
  log "Панель откатилась к $version"
}

uninstall_panel() {
  require_root
  systemctl disable --now "$SERVICE_NAME" wdtt-fleet-manager-cert-renew.timer 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME" /etc/systemd/system/wdtt-fleet-manager-cert-renew.service /etc/systemd/system/wdtt-fleet-manager-cert-renew.timer "$NGINX_FILE" "$AUTH_FILE"
  rm -f /usr/local/sbin/wdtt-fleet /usr/local/sbin/wdtt-fleet-update /usr/local/sbin/wdtt-fleet-status /usr/local/sbin/wdtt-fleet-uninstall
  rm -rf "$INSTALL_DIR" "$CONFIG_DIR"
  systemctl daemon-reload
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  log "Панель удалена. Каталог состояния оставлен: $STATE_DIR"
}

menu() {
  require_root
  [ -r /dev/tty ] && [ -w /dev/tty ] || die "Интерактивное меню требует терминал"
  while true; do
    if [ ! -r "$CONFIG_DIR/panel.conf" ]; then
      printf '\nWDTT Fleet Manager\n1) Установить  0) Выход\n'
      read -r -p 'Выберите действие [0-1]: ' answer </dev/tty
      case "$answer" in 1) install_panel ;; 0) return ;; *) log "Неверный выбор" ;; esac
      continue
    fi
    printf '\nWDTT Fleet Manager\n'
    printf '1) Обновить из GitHub   2) Откатить к тегу   3) Статус   4) Перезапустить\n'
    printf '5) Журнал сервиса        6) Сертификат        7) Обновить сертификат\n'
    printf '8) Сменить пароль        9) Изменить URL      10) Удалить панель  0) Выход\n'
    read -r -p 'Выберите действие [0-10]: ' answer </dev/tty
    case "$answer" in
      1) update_panel ;;
      2) rollback_panel ;;
      3) show_status ;;
      4) restart_panel ;;
      5) show_logs ;;
      6) show_certificate_status ;;
      7) renew_certificates || true ;;
      8) change_password ;;
      9) change_path ;;
      10) read -r -p 'Удалить только Fleet Manager? [y/N]: ' confirm </dev/tty; [[ "$confirm" =~ ^[Yy]$ ]] && uninstall_panel ;;
      0) return ;;
      *) log "Неверный выбор" ;;
    esac
  done
}

command="${1:-menu}"
shift || true
case "$command" in
  install|--install|-i) parse_options "$@"; install_panel ;;
  update|--update) update_panel ;;
  rollback|--rollback) rollback_panel "${1:-}" ;;
  status|--status|-s) show_status ;;
  restart|--restart) restart_panel ;;
  logs|--logs) show_logs ;;
  cert-status|--cert-status) show_certificate_status ;;
  renew-cert|--renew-cert) renew_certificates ;;
  change-password|--change-password) parse_options "$@"; change_password ;;
  change-path|--change-path) change_path ;;
  uninstall|--uninstall|-u) uninstall_panel ;;
  menu) menu ;;
  *) die "Использование: $0 [install|update|rollback|status|restart|logs|cert-status|renew-cert|change-password|change-path|uninstall]" ;;
esac

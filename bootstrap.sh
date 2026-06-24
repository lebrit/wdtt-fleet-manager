#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${WDTT_FLEET_REPOSITORY:-lebrit/wdtt-fleet-manager}"
BRANCH="${WDTT_FLEET_BRANCH:-main}"
SCRIPT_URL="https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/install.sh"
TEMP_SCRIPT=""
ACTION=""
INTERACTIVE=0
PANEL_HOST=""
PANEL_USER="admin"
PANEL_PASSWORD=""
PANEL_EMAIL=""
PANEL_HTTPS_PORT="8444"
PANEL_PATH=""

cleanup() { [ -z "$TEMP_SCRIPT" ] || rm -f "$TEMP_SCRIPT"; }
trap cleanup EXIT

usage() {
  cat <<EOF
Использование: bootstrap.sh [действие] [параметры]

Без параметров открывается интерактивное меню.

Действия: install, update, rollback, status, restart, logs, cert-status,
          renew-cert, change-password, change-path, uninstall

Для автоматической установки:
  install --domain fleet.example.com --user admin --password 'минимум-12-символов' --non-interactive
EOF
}

require_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ] || {
    echo "Интерактивное меню требует терминал. Для автоматизации укажите install и --non-interactive." >&2
    exit 2
  }
}

prompt_value() {
  local prompt="$1" default_value="${2:-}" value
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$prompt" "$default_value" >/dev/tty
  else
    printf '%s: ' "$prompt" >/dev/tty
  fi
  IFS= read -r value </dev/tty || true
  printf '%s' "${value:-$default_value}"
}

prompt_install_options() {
  local choice
  require_tty

  cat >/dev/tty <<'EOF'

Настройка новой панели
1) Указать домен
2) Указать публичный IPv4
3) Определить публичный IPv4 автоматически
EOF
  printf 'Адрес панели [3]: ' >/dev/tty
  IFS= read -r choice </dev/tty || true
  case "${choice:-3}" in
    1) PANEL_HOST="$(prompt_value 'Домен панели')" ;;
    2) PANEL_HOST="$(prompt_value 'Публичный IPv4')" ;;
    3) PANEL_HOST="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)" ;;
    *) echo 'Неизвестный вариант адреса.' >/dev/tty; exit 2 ;;
  esac
  [ -n "$PANEL_HOST" ] || PANEL_HOST="$(prompt_value 'Домен или публичный IPv4')"
  [ -n "$PANEL_HOST" ] || { echo 'Адрес панели обязателен.' >/dev/tty; exit 2; }

  PANEL_EMAIL="$(prompt_value "Email для Let's Encrypt (необязательно)")"
  PANEL_USER="$(prompt_value 'Логин администратора' 'admin')"
  PANEL_HTTPS_PORT="$(prompt_value 'HTTPS-порт панели' '8444')"
  PANEL_PATH="$(prompt_value 'Секретный URL-путь (Enter — сгенерировать)')"

  while [ "${#PANEL_PASSWORD}" -lt 12 ]; do
    printf 'Пароль панели (минимум 12 символов): ' >/dev/tty
    IFS= read -r -s PANEL_PASSWORD </dev/tty || true
    printf '\n' >/dev/tty
    [ "${#PANEL_PASSWORD}" -ge 12 ] || echo 'Пароль слишком короткий.' >/dev/tty
  done
}

choose_action() {
  local choice
  require_tty
  if [ ! -r /etc/wdtt-fleet-manager/panel.conf ]; then
    cat >/dev/tty <<'EOF'

WDTT Fleet Manager
1) Установить новую панель
0) Выход
EOF
    printf 'Выберите действие [1]: ' >/dev/tty
    IFS= read -r choice </dev/tty || true
    case "${choice:-1}" in
      1) ACTION="install"; prompt_install_options ;;
      0) ACTION="exit" ;;
      *) echo 'Неизвестный пункт меню.' >/dev/tty; exit 2 ;;
    esac
    return
  fi

  cat >/dev/tty <<'EOF'

WDTT Fleet Manager
1) Обновить из GitHub          2) Откатить к версии
3) Показать статус и адрес     4) Перезапустить службу
5) Показать журнал             6) Проверить сертификат
7) Обновить сертификат         8) Сменить пароль панели
9) Изменить секретный URL      10) Удалить только Fleet Manager
0) Выход
EOF
  printf 'Выберите действие [0-10]: ' >/dev/tty
  IFS= read -r choice </dev/tty || true
  case "$choice" in
    1) ACTION="update" ;;
    2) ACTION="rollback" ;;
    3) ACTION="status" ;;
    4) ACTION="restart" ;;
    5) ACTION="logs" ;;
    6) ACTION="cert-status" ;;
    7) ACTION="renew-cert" ;;
    8) ACTION="change-password" ;;
    9) ACTION="change-path" ;;
    10)
      printf 'Удалить только WDTT Fleet Manager? [y/N]: ' >/dev/tty
      IFS= read -r choice </dev/tty || true
      case "$choice" in y|Y|yes|YES|да|ДА) ACTION="uninstall" ;; *) ACTION="exit" ;; esac
      ;;
    0|"") ACTION="exit" ;;
    *) echo 'Неизвестный пункт меню.' >/dev/tty; exit 2 ;;
  esac
}

if [ "$#" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || { echo 'Запустите через sudo.' >&2; exit 1; }
  INTERACTIVE=1
  choose_action
elif [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

[ "${ACTION:-}" != "exit" ] || exit 0

TEMP_SCRIPT="$(mktemp)"
curl -fsSL --retry 3 "$SCRIPT_URL" -o "$TEMP_SCRIPT"

if [ "$INTERACTIVE" = "1" ]; then
  export PANEL_HOST PANEL_USER PANEL_PASSWORD PANEL_EMAIL PANEL_HTTPS_PORT PANEL_PATH
  bash "$TEMP_SCRIPT" "$ACTION" </dev/tty
else
  bash "$TEMP_SCRIPT" "$@"
fi

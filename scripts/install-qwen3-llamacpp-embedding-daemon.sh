#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the MBrain Qwen3 llama.cpp embedding runtime as a user daemon.

USAGE
  scripts/install-qwen3-llamacpp-embedding-daemon.sh [options]

OPTIONS
  --print systemd|launchd   Print the service profile without installing
  --uninstall               Remove the installed service profile
  --status                  Show service status
  --enable-linger           Linux only: enable user lingering for boot/log-out persistence
  -h, --help                Show this help

ENVIRONMENT
  MBRAIN_LLAMA_CPP_PORT=8080
  MBRAIN_LOCAL_EMBEDDING_MODEL=qwen3-embedding:0.6b
  MBRAIN_LLAMA_CPP_BUILD_DIR=/tmp/llama.cpp-mbrain/build-mbrain
  MBRAIN_LLAMA_CPP_SYSTEMD_CONFIG_HOME=/home/user/.config
  LLAMA_SERVER=/absolute/path/to/llama-server
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUN_SCRIPT="$REPO_ROOT/scripts/run-qwen3-llamacpp-embedding-cpu.sh"

SYSTEMD_SERVICE_NAME="${MBRAIN_LLAMA_CPP_SYSTEMD_SERVICE_NAME:-mbrain-qwen3-embedding.service}"
LAUNCHD_LABEL="${MBRAIN_LLAMA_CPP_LAUNCHD_LABEL:-com.mbrain.qwen3-embedding}"
LAUNCHD_PLIST_NAME="${LAUNCHD_LABEL}.plist"
LLAMA_CPP_BUILD_DIR="${MBRAIN_LLAMA_CPP_BUILD_DIR:-/tmp/llama.cpp-mbrain/build-mbrain}"
PORT="${MBRAIN_LLAMA_CPP_PORT:-8080}"
MODEL_ALIAS="${MBRAIN_LOCAL_EMBEDDING_MODEL:-qwen3-embedding:0.6b}"
LOG_DIR="${MBRAIN_LLAMA_CPP_LOG_DIR:-$HOME/.mbrain/logs}"

ACTION="install"
PRINT_PROFILE=""
ENABLE_LINGER="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print)
      ACTION="print"
      PRINT_PROFILE="${2:-}"
      shift 2
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    --enable-linger)
      ENABLE_LINGER="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_run_script() {
  if [[ ! -x "$RUN_SCRIPT" ]]; then
    echo "Embedding run script is missing or not executable: $RUN_SCRIPT" >&2
    exit 1
  fi
}

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' \
          -e 's/</\&lt;/g' \
          -e 's/>/\&gt;/g' \
          -e 's/"/\&quot;/g'
}

systemd_quote() {
  local value
  value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

render_systemd() {
  cat <<UNIT
[Unit]
Description=MBrain Qwen3 embedding server
After=network.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$REPO_ROOT")
Environment=$(systemd_quote "MBRAIN_LLAMA_CPP_BUILD_DIR=$LLAMA_CPP_BUILD_DIR")
Environment=$(systemd_quote "MBRAIN_LLAMA_CPP_PORT=$PORT")
Environment=$(systemd_quote "MBRAIN_LOCAL_EMBEDDING_MODEL=$MODEL_ALIAS")
ExecStart=/bin/bash $(systemd_quote "$RUN_SCRIPT")
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
}

render_launchd() {
  local repo_root run_script build_dir port model_alias log_dir label
  repo_root="$(xml_escape "$REPO_ROOT")"
  run_script="$(xml_escape "$RUN_SCRIPT")"
  build_dir="$(xml_escape "$LLAMA_CPP_BUILD_DIR")"
  port="$(xml_escape "$PORT")"
  model_alias="$(xml_escape "$MODEL_ALIAS")"
  log_dir="$(xml_escape "$LOG_DIR")"
  label="$(xml_escape "$LAUNCHD_LABEL")"

  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>WorkingDirectory</key>
  <string>$repo_root</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$run_script</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MBRAIN_LLAMA_CPP_BUILD_DIR</key>
    <string>$build_dir</string>
    <key>MBRAIN_LLAMA_CPP_PORT</key>
    <string>$port</string>
    <key>MBRAIN_LOCAL_EMBEDDING_MODEL</key>
    <string>$model_alias</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/qwen3-embedding.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/qwen3-embedding.err.log</string>
</dict>
</plist>
PLIST
}

detect_profile() {
  case "$(uname -s)" in
    Linux) echo "systemd" ;;
    Darwin) echo "launchd" ;;
    *)
      echo "Unsupported OS: $(uname -s). Use --print systemd|launchd and install manually." >&2
      exit 1
      ;;
  esac
}

systemd_user_home() {
  if command -v getent >/dev/null 2>&1; then
    local passwd_entry passwd_home
    passwd_entry="$(getent passwd "${USER:-$(id -un)}" || true)"
    passwd_home="$(printf '%s' "$passwd_entry" | awk -F: '{print $6}')"
    if [[ -n "$passwd_home" ]]; then
      printf '%s\n' "$passwd_home"
      return
    fi
  fi

  printf '%s\n' "$HOME"
}

systemd_user_config_dir() {
  if [[ -n "${MBRAIN_LLAMA_CPP_SYSTEMD_CONFIG_HOME:-}" ]]; then
    printf '%s\n' "$MBRAIN_LLAMA_CPP_SYSTEMD_CONFIG_HOME/systemd/user"
    return
  fi

  printf '%s\n' "$(systemd_user_home)/.config/systemd/user"
}

install_systemd() {
  require_run_script
  local user_dir service_path
  user_dir="$(systemd_user_config_dir)"
  service_path="$user_dir/$SYSTEMD_SERVICE_NAME"
  mkdir -p "$user_dir"
  render_systemd > "$service_path"

  systemctl --user daemon-reload
  systemctl --user enable --now "$SYSTEMD_SERVICE_NAME"

  if [[ "$ENABLE_LINGER" == "true" ]]; then
    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$USER" 2>/dev/null \
        || sudo loginctl enable-linger "$USER"
    else
      echo "loginctl not found; skipping linger enablement." >&2
    fi
  fi

  echo "Installed and started systemd user service: $SYSTEMD_SERVICE_NAME"
  echo "Service file: $service_path"
  echo "Logs: journalctl --user -u $SYSTEMD_SERVICE_NAME -f"
}

install_launchd() {
  require_run_script
  local agents_dir plist_path uid
  agents_dir="$HOME/Library/LaunchAgents"
  plist_path="$agents_dir/$LAUNCHD_PLIST_NAME"
  uid="$(id -u)"
  mkdir -p "$agents_dir" "$LOG_DIR"
  render_launchd > "$plist_path"

  launchctl bootout "gui/$uid" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$plist_path"
  launchctl enable "gui/$uid/$LAUNCHD_LABEL"
  launchctl kickstart -k "gui/$uid/$LAUNCHD_LABEL"

  echo "Installed and started launchd agent: $LAUNCHD_LABEL"
  echo "Plist: $plist_path"
  echo "Logs: $LOG_DIR/qwen3-embedding.err.log"
}

uninstall_systemd() {
  local service_path
  service_path="$(systemd_user_config_dir)/$SYSTEMD_SERVICE_NAME"
  systemctl --user disable --now "$SYSTEMD_SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$service_path"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  echo "Removed systemd user service: $SYSTEMD_SERVICE_NAME"
}

uninstall_launchd() {
  local plist_path uid
  plist_path="$HOME/Library/LaunchAgents/$LAUNCHD_PLIST_NAME"
  uid="$(id -u)"
  launchctl bootout "gui/$uid" "$plist_path" >/dev/null 2>&1 || true
  rm -f "$plist_path"
  echo "Removed launchd agent: $LAUNCHD_LABEL"
}

status_systemd() {
  systemctl --user status "$SYSTEMD_SERVICE_NAME" --no-pager
}

status_launchd() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL"
}

if [[ "$ACTION" == "print" ]]; then
  case "$PRINT_PROFILE" in
    systemd) render_systemd ;;
    launchd) render_launchd ;;
    *)
      echo "--print requires systemd or launchd" >&2
      exit 2
      ;;
  esac
  exit 0
fi

PROFILE="$(detect_profile)"
case "$ACTION:$PROFILE" in
  install:systemd) install_systemd ;;
  install:launchd) install_launchd ;;
  uninstall:systemd) uninstall_systemd ;;
  uninstall:launchd) uninstall_launchd ;;
  status:systemd) status_systemd ;;
  status:launchd) status_launchd ;;
  *)
    echo "Unsupported action/profile: $ACTION/$PROFILE" >&2
    exit 1
    ;;
esac

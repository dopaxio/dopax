#!/bin/zsh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT="${APP_SUPPORT:-$HOME/Library/Application Support/matrix-agent-ts}"
LAUNCH_AGENTS="${LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"

build_launchd_path() {
  local paths=(
    "$HOME/.local/bin"
    "$HOME/.local/share/mise/shims"
    "$HOME/.cargo/bin"
    "$HOME/.bun/bin"
    "$HOME/.npm-global/bin"
    "$HOME/.opencode/bin"
    "$HOME/.volta/bin"
    "$HOME/Library/pnpm"
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  )

  local joined=""
  local path
  for path in "${paths[@]}"; do
    if [ -z "$joined" ]; then
      joined="$path"
    else
      joined="$joined:$path"
    fi
  done
  printf '%s' "$joined"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/manage-instance.sh install <instance>
  scripts/manage-instance.sh start <instance>
  scripts/manage-instance.sh stop <instance>
  scripts/manage-instance.sh restart <instance>
  scripts/manage-instance.sh status <instance>
  scripts/manage-instance.sh list

Instances are defined by files under instances/<instance>.env
EOF
}

require_instance() {
  if [ $# -lt 1 ]; then
    usage
    exit 1
  fi
}

instance_label() {
  printf 'com.uu.matrix-agent-ts.%s' "$1"
}

instance_env() {
  printf '%s/instances/%s.env' "$ROOT" "$1"
}

instance_runtime() {
  printf '%s/%s' "$APP_SUPPORT" "$1"
}

instance_plist() {
  printf '%s/%s.plist' "$LAUNCH_AGENTS" "$(instance_label "$1")"
}

load_instance_env() {
  local env_file="$1"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

assert_provider_cli_available() {
  local instance="$1"
  local provider_bin="$2"

  if [ -z "${provider_bin:-}" ]; then
    echo "Instance $instance is missing PROVIDER_BIN in its env file." >&2
    exit 1
  fi

  if [[ "$provider_bin" == */* ]]; then
    if [ ! -x "$provider_bin" ]; then
      echo "Instance $instance cannot start: PROVIDER_BIN is not executable: $provider_bin" >&2
      exit 1
    fi
    return
  fi

  if ! PATH="$(build_launchd_path)" command -v "$provider_bin" >/dev/null 2>&1; then
    echo "Instance $instance cannot start: CLI '$provider_bin' is not installed or not on PATH." >&2
    exit 1
  fi
}

install_instance() {
  local instance="$1"
  local env_file="$(instance_env "$instance")"
  local runtime_dir="$(instance_runtime "$instance")"
  local plist_file="$(instance_plist "$instance")"

  if [ ! -f "$env_file" ]; then
    echo "Missing instance env: $env_file" >&2
    exit 1
  fi

  load_instance_env "$env_file"
  if [ "${DEFAULT_ROOM_MODE:-shared}" != "container" ]; then
    assert_provider_cli_available "$instance" "${PROVIDER_BIN:-}"
  fi

  mkdir -p "$runtime_dir/storage" "$runtime_dir/workdir" "$LAUNCH_AGENTS"
  rm -rf "$runtime_dir/dist" "$runtime_dir/node_modules" "$runtime_dir/package.json"
  rsync -a "$ROOT/dist/" "$runtime_dir/dist/"
  rsync -aL "$ROOT/node_modules/" "$runtime_dir/node_modules/"
  cp "$ROOT/package.json" "$runtime_dir/package.json"
  cp "$env_file" "$runtime_dir/.env"

  local plist_path_env="$(build_launchd_path)"
  cat > "$runtime_dir/run-agent.sh" <<EOF
#!/bin/zsh
set -eu
cd "$runtime_dir"
export PATH="$plist_path_env"
node_bin="\${NODE_BIN:-\$(command -v node 2>/dev/null || true)}"
if [ -z "\$node_bin" ]; then
  echo "Unable to resolve node from PATH. Set NODE_BIN to an absolute Node.js binary." >&2
  exit 1
fi
exec "\$node_bin" dist/index.js
EOF
  chmod +x "$runtime_dir/run-agent.sh"

  cat > "$plist_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$(instance_label "$instance")</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>$runtime_dir/run-agent.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$plist_path_env</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$runtime_dir/storage/agent.log</string>
    <key>StandardErrorPath</key>
    <string>$runtime_dir/storage/agent.error.log</string>
</dict>
</plist>
EOF
  echo "Installed instance $instance"
}

start_instance() {
  local instance="$1"
  install_instance "$instance"
  launchctl bootstrap "gui/$(id -u)" "$(instance_plist "$instance")" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/$(instance_label "$instance")"
}

stop_instance() {
  local instance="$1"
  launchctl bootout "gui/$(id -u)/$(instance_label "$instance")" 2>/dev/null || true
}

status_instance() {
  local instance="$1"
  launchctl print "gui/$(id -u)/$(instance_label "$instance")"
}

list_instances() {
  find "$ROOT/instances" -maxdepth 1 -type f -name '*.env' -print 2>/dev/null | sed 's#^.*/##; s#\.env$##' | sort
}

action="${1:-}"
case "$action" in
  install)
    shift
    require_instance "$@"
    install_instance "$1"
    ;;
  start)
    shift
    require_instance "$@"
    start_instance "$1"
    ;;
  stop)
    shift
    require_instance "$@"
    stop_instance "$1"
    ;;
  restart)
    shift
    require_instance "$@"
    stop_instance "$1"
    start_instance "$1"
    ;;
  status)
    shift
    require_instance "$@"
    status_instance "$1"
    ;;
  list)
    list_instances
    ;;
  *)
    usage
    exit 1
    ;;
esac

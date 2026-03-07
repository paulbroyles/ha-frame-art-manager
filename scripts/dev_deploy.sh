#!/bin/bash

# Frame Art Manager add-on quick-deploy script
#
# Stops the running add-on, copies local source files to the HA add-ons directory,
# rebuilds the Docker image, and starts the add-on again. The add-on's ingress
# panel (sidebar entry) is preserved automatically since it is defined in config.yaml.
#
# Uses "ha apps" CLI (the current name; "ha addons" is deprecated).
# The add-on slug for local add-ons is prefixed with "local_".
#
# Usage examples:
#   ./scripts/dev_deploy.sh                 # deploy to default host (ha)
#   ./scripts/dev_deploy.sh --host 192.168.1.50
#   ./scripts/dev_deploy.sh --no-restart    # copy files only, skip stop/rebuild/start
#   ./scripts/dev_deploy.sh --help
#
# Options:
#   --host <hostname>       SSH host for Home Assistant (default: ha)
#   --user <username>       SSH user (default: use ssh config / current user)
#   --no-restart            Copy files only; do not stop/rebuild/start the add-on
#   --help                  Show this help text
#
# Prerequisites:
#   - SSH access to the HA host as a user that can run "ha" CLI commands
#   - The add-on must already be installed as a local add-on at
#     /addons/local/frame_art_manager on the HA host
#   - node_modules is excluded from the transfer; the add-on image installs deps
#     at build time via Dockerfile

set -euo pipefail

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
}

HA_HOST="ha"
HA_USER=""
RESTART_ADDON=true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            HA_HOST="$2"
            shift 2
            ;;
        --user)
            HA_USER="$2"
            shift 2
            ;;
        --no-restart)
            RESTART_ADDON=false
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo
            usage
            exit 1
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDON_SRC="$REPO_ROOT/frame_art_manager"
ADDON_DIR="frame_art_manager"          # directory name under /addons/local/
ADDON_SLUG="local_frame_art_manager"   # slug used by the ha apps CLI
REMOTE_PATH="/addons/local/$ADDON_DIR"

if [[ ! -f "$ADDON_SRC/config.yaml" ]]; then
    echo "config.yaml not found at $ADDON_SRC/config.yaml" >&2
    exit 1
fi

if [[ -n "$HA_USER" ]]; then
    REMOTE_TARGET="$HA_USER@$HA_HOST"
else
    REMOTE_TARGET="$HA_HOST"
fi

ADDON_VERSION=$(grep '^version:' "$ADDON_SRC/config.yaml" | head -1 | sed 's/version: *//;s/"//g')
echo "Add-on version: $ADDON_VERSION"
echo "Deploying to $REMOTE_TARGET:$REMOTE_PATH"

if [[ "$RESTART_ADDON" == true ]]; then
    echo "Stopping add-on..."
    ssh -T "$REMOTE_TARGET" "ha apps stop $ADDON_SLUG" || echo "(stop failed or add-on was already stopped)"
fi

echo "Syncing files..."
ssh -T "$REMOTE_TARGET" "mkdir -p '$REMOTE_PATH'"

tar -C "$ADDON_SRC" \
    --exclude='app/node_modules' \
    --exclude='app/.npm' \
    --exclude='**/__pycache__' \
    --exclude='**/*.pyc' \
    --exclude='.DS_Store' \
    -czf - . \
    | ssh -T "$REMOTE_TARGET" "tar -xzf - -C '$REMOTE_PATH'"

echo "Files synced."

if [[ "$RESTART_ADDON" == true ]]; then
    echo "Rebuilding add-on (this installs npm dependencies and may take a minute)..."
    ssh -T "$REMOTE_TARGET" "ha apps rebuild $ADDON_SLUG"
    echo "Starting add-on..."
    ssh -T "$REMOTE_TARGET" "ha apps start $ADDON_SLUG"
    echo "Add-on started. The sidebar panel should appear automatically."
    echo "If the panel is missing, reload the browser or restart Home Assistant."
fi

echo "Done."
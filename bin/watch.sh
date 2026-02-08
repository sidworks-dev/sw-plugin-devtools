#!/usr/bin/env bash

SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

# Find Shopware project root by walking up
PROJECT_ROOT="$PLUGIN_ROOT"
while [ "$PROJECT_ROOT" != "/" ]; do
    if [ -d "$PROJECT_ROOT/vendor/shopware" ] && [ -d "$PROJECT_ROOT/var" ]; then
        break
    fi
    PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done

if [ "$PROJECT_ROOT" = "/" ]; then
    echo "Error: Could not find Shopware project root."
    exit 1
fi

# This script runs on the HOST, not inside DDEV
if [ -f /.dockerenv ]; then
    echo "Error: This script must run on your host machine, not inside DDEV."
    echo "Usage: custom/plugins/SidworksDevTools/bin/watch.sh"
    exit 1
fi

# Ensure bun is available
if ! command -v bun &> /dev/null; then
    echo "Error: bun is not installed. Install it with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "$PLUGIN_ROOT/node_modules/sass" ]; then
    echo "Installing dependencies with bun..."
    bun install --cwd "$PLUGIN_ROOT"
fi

# Kill any leftover hot-reload server
lsof -ti:9779 | xargs kill -9 2>/dev/null

# Dump theme config and compile once (establishes correct CSS path)
echo "Preparing theme..."
ddev exec bin/console bundle:dump
ddev exec bin/console feature:dump
ddev exec bin/console theme:dump
ddev exec bin/console theme:compile --active-only

echo ""
echo "Starting SCSS watcher with hot-reload..."
echo ""

# Run the fast SCSS watcher
exec bun run "$SCRIPT_DIR/watch.mjs"

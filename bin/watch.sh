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

# Find JS runtime: prefer bun, fall back to node
if command -v bun &> /dev/null; then
    RUNTIME="bun"
elif command -v node &> /dev/null; then
    RUNTIME="node"
else
    echo "Error: Neither bun nor node found. Install one of them."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "$PLUGIN_ROOT/node_modules/sass" ]; then
    echo "Installing dependencies..."
    if [ "$RUNTIME" = "bun" ]; then
        bun install --cwd "$PLUGIN_ROOT"
    else
        npm install --prefix "$PLUGIN_ROOT"
    fi
fi

# Kill any leftover hot-reload server
lsof -ti:9779 | xargs kill -9 2>/dev/null

# Run the watcher (prep + compile + watch, all in one)
exec "$RUNTIME" "$SCRIPT_DIR/watch.mjs"

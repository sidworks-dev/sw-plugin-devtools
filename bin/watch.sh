#!/usr/bin/env bash

set -euo pipefail

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

echo "SidworksDevTools legacy watcher is deprecated."
echo "Forwarding to unified watcher: bin/watch-storefront.sh"

# Host entrypoint -> run inside DDEV container
exec ddev exec env PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 /var/www/html/bin/watch-storefront.sh --use-plugin-hot-proxy "$@"

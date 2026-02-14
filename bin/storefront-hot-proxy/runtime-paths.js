const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function resolveProjectRoot(startDir) {
    if (process.env.PROJECT_ROOT) {
        return path.resolve(process.env.PROJECT_ROOT);
    }

    let dir = path.resolve(startDir || __dirname);

    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'vendor/shopware')) && fs.existsSync(path.join(dir, 'var'))) {
            return dir;
        }

        dir = path.dirname(dir);
    }

    throw new Error('Could not resolve Shopware project root. Set PROJECT_ROOT in the environment.');
}

function resolveStorefrontRoot(projectRoot) {
    const platformStorefrontRoot = path.resolve(projectRoot, 'vendor/shopware/platform/src/Storefront');
    if (fs.existsSync(platformStorefrontRoot)) {
        return platformStorefrontRoot;
    }

    return path.resolve(projectRoot, 'vendor/shopware/storefront');
}

function resolveStorefrontApp(projectRoot) {
    return path.resolve(resolveStorefrontRoot(projectRoot), 'Resources/app/storefront');
}

function createStorefrontRequire(projectRoot) {
    const storefrontApp = resolveStorefrontApp(projectRoot);
    return createRequire(path.resolve(storefrontApp, 'package.json'));
}

module.exports = {
    resolveProjectRoot,
    resolveStorefrontRoot,
    resolveStorefrontApp,
    createStorefrontRequire,
};

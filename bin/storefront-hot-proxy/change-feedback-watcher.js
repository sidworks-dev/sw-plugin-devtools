/* eslint no-console: 0 */

const fs = require('node:fs');
const path = require('node:path');

const {
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');

function createChangeFeedbackWatcher(projectRoot) {
    const DUPLICATE_LOG_WINDOW_MS = 800;
    const rootPath = path.resolve(projectRoot);
    const storefrontApp = resolveStorefrontApp(rootPath);
    const storefrontRequire = createStorefrontRequire(rootPath);
    const Watchpack = storefrontRequire('watchpack');
    const coreOnlyHotMode = process.env.SHOPWARE_STOREFRONT_HOT_CORE_ONLY === '1';
    const disableJsCompilation = process.env.SHOPWARE_STOREFRONT_DISABLE_JS === '1';
    const disableTwigWatch = process.env.SHOPWARE_STOREFRONT_DISABLE_TWIG === '1';
    const coreStorefrontJsRoot = path.resolve(storefrontApp, 'src');

    let watchpack = null;
    const recentlyLogged = new Map();

    function isExistingDirectory(directoryPath) {
        return fs.existsSync(directoryPath) && fs.statSync(directoryPath).isDirectory();
    }

    function isPathInside(childPath, parentPath) {
        const normalizedChild = path.resolve(childPath);
        const normalizedParent = path.resolve(parentPath);

        return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep);
    }

    function readPluginsConfig() {
        const pluginsConfigPath = path.resolve(rootPath, 'var/plugins.json');
        if (!fs.existsSync(pluginsConfigPath)) {
            return [];
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(pluginsConfigPath, 'utf8'));
            return typeof parsed === 'object' && parsed !== null
                ? Object.values(parsed)
                : [];
        } catch (_error) {
            return [];
        }
    }

    function resolvePluginBasePath(pluginConfig) {
        const basePath = typeof pluginConfig?.basePath === 'string' ? pluginConfig.basePath : '';
        if (basePath === '') {
            return rootPath;
        }

        return path.isAbsolute(basePath)
            ? basePath
            : path.resolve(rootPath, basePath);
    }

    function collectWatchDirectories() {
        const directories = new Set();
        const storefrontViewsRoot = path.resolve(storefrontApp, '..', '..', 'views');

        const baseDirectories = [
            path.resolve(storefrontApp, 'src'),
            path.resolve(rootPath, 'src/Resources/views'),
            path.resolve(rootPath, 'templates'),
            storefrontViewsRoot,
            path.resolve(rootPath, 'custom/plugins'),
            path.resolve(rootPath, 'custom/apps'),
        ].filter(isExistingDirectory);

        baseDirectories.forEach((directoryPath) => directories.add(directoryPath));

        const pluginConfigs = readPluginsConfig();
        for (const pluginConfig of pluginConfigs) {
            const pluginBasePath = resolvePluginBasePath(pluginConfig);

            const viewDirectories = Array.isArray(pluginConfig?.views) ? pluginConfig.views : [];
            for (const viewDirectory of viewDirectories) {
                if (typeof viewDirectory !== 'string' || viewDirectory === '') {
                    continue;
                }

                const resolvedViewDirectory = path.resolve(pluginBasePath, viewDirectory);
                if (
                    isExistingDirectory(resolvedViewDirectory) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedViewDirectory, directoryPath))
                ) {
                    directories.add(resolvedViewDirectory);
                }
            }

            const storefrontPath = typeof pluginConfig?.storefront?.path === 'string'
                ? pluginConfig.storefront.path
                : '';
            if (storefrontPath !== '') {
                const resolvedStorefrontPath = path.resolve(pluginBasePath, storefrontPath);
                if (
                    isExistingDirectory(resolvedStorefrontPath) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedStorefrontPath, directoryPath))
                ) {
                    directories.add(resolvedStorefrontPath);
                }
            }

            const entryFilePath = typeof pluginConfig?.storefront?.entryFilePath === 'string'
                ? pluginConfig.storefront.entryFilePath
                : '';
            if (entryFilePath !== '') {
                const resolvedEntryDirectory = path.dirname(path.resolve(pluginBasePath, entryFilePath));
                if (
                    isExistingDirectory(resolvedEntryDirectory) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedEntryDirectory, directoryPath))
                ) {
                    directories.add(resolvedEntryDirectory);
                }
            }
        }

        return [...directories];
    }

    function formatFilePath(absoluteFilePath) {
        if (typeof absoluteFilePath !== 'string' || absoluteFilePath === '') {
            return '';
        }

        const normalizedRoot = path.resolve(rootPath);
        const normalizedFile = path.resolve(absoluteFilePath);
        if (normalizedFile.startsWith(normalizedRoot + path.sep)) {
            return path.relative(normalizedRoot, normalizedFile).replace(/\\/g, '/');
        }

        return absoluteFilePath.replace(/\\/g, '/');
    }

    function classifyFile(filePath) {
        const extension = path.extname(filePath).toLowerCase();
        if (extension === '.twig') {
            return 'twig';
        }

        if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(extension)) {
            return 'js';
        }

        return '';
    }

    function shouldSkipDuplicate(eventType, formattedFile) {
        const dedupeKey = `${eventType}:${formattedFile}`;
        const now = Date.now();
        const previous = recentlyLogged.get(dedupeKey) || 0;
        recentlyLogged.set(dedupeKey, now);
        return now - previous < DUPLICATE_LOG_WINDOW_MS;
    }

    function isCoreStorefrontJsFile(filePath) {
        const normalizedFile = path.resolve(filePath);
        return normalizedFile.startsWith(coreStorefrontJsRoot + path.sep);
    }

    function handleFileEvent(eventType, absoluteFilePath) {
        const fileType = classifyFile(absoluteFilePath);
        if (!fileType) {
            return;
        }

        const formattedFile = formatFilePath(absoluteFilePath);
        if (!formattedFile || shouldSkipDuplicate(eventType, formattedFile)) {
            return;
        }

        if (fileType === 'js') {
            if (isCoreStorefrontJsFile(absoluteFilePath) && !disableJsCompilation) {
                // Core storefront JS is already logged via webpack compiler hooks.
                return;
            }

            if (disableJsCompilation) {
                console.log(`[SidworksDevTools] js ${eventType}: ${formattedFile} (JS changed; skipped in --no-js mode)`);
                return;
            }

            if (coreOnlyHotMode) {
                console.log(`[SidworksDevTools] js ${eventType}: ${formattedFile} (plugin JS changed; skipped in core-only-hot mode)`);
                return;
            }

            console.log(`[SidworksDevTools] js ${eventType}: ${formattedFile}`);
            return;
        }

        if (fileType === 'twig') {
            if (disableTwigWatch) {
                return;
            }

            console.log(`[SidworksDevTools] twig ${eventType}: ${formattedFile} (live reload)`);
        }
    }

    function start() {
        if (watchpack) {
            return true;
        }

        const directoriesToWatch = collectWatchDirectories();
        if (directoriesToWatch.length === 0) {
            return false;
        }

        watchpack = new Watchpack({
            aggregateTimeout: 80,
            ignored: [
                '**/.git/**',
                '**/node_modules/**',
                '**/var/cache/**',
                '**/public/_sidworks_hot/**',
                '**/var/.sidworks-hot/**',
            ],
        });

        watchpack.on('change', (filePath) => handleFileEvent('change', filePath));
        watchpack.on('remove', (filePath) => handleFileEvent('remove', filePath));
        watchpack.watch([], directoriesToWatch, Date.now() - 1000);
        return true;
    }

    function close() {
        if (watchpack) {
            watchpack.close();
            watchpack = null;
        }
    }

    return {
        start,
        close,
    };
}

module.exports = {
    createChangeFeedbackWatcher,
};

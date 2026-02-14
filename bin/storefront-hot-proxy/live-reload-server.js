/* eslint no-console: 0 */

const loadPatchedWebpackConfig = require('./patch-webpack-config');
const {
    resolveProjectRoot,
    createStorefrontRequire,
} = require('./runtime-paths');

module.exports = function createLiveReloadServer(sslOptions) {
    return new Promise((resolve, reject) => {
        const projectRoot = resolveProjectRoot(__dirname);
        const storefrontRequire = createStorefrontRequire(projectRoot);
        const webpack = storefrontRequire('webpack');
        const WebpackDevServer = storefrontRequire('webpack-dev-server');

        const webpackConfig = loadPatchedWebpackConfig(projectRoot);
        const compiler = webpack(webpackConfig);
        const coreWebpackConfig = Array.isArray(webpackConfig) ? webpackConfig[0] : webpackConfig;

        let serverConfig = {
            type: 'http',
        };
        if (Object.keys(sslOptions).length !== 0) {
            serverConfig = {
                type: 'https',
                options: sslOptions,
            };
        }

        const baseDevServer = coreWebpackConfig.devServer || {};
        const devServerOptions = {
            ...baseDevServer,
            open: false,
            host: '0.0.0.0',
            server: serverConfig,
            devMiddleware: {
                ...(baseDevServer.devMiddleware || {}),
                stats: {
                    colors: true,
                },
            },
        };

        const server = new WebpackDevServer(devServerOptions, compiler);

        (async () => {
            try {
                await server.start();
            } catch (error) {
                reject(error);
                return;
            }

            console.log('Starting the SidworksDevTools hot reload server:\n');
        })();

        compiler.hooks.done.tap('resolveServer', () => {
            resolve(server);
        });
    });
};

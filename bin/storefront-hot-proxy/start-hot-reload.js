/* eslint no-console: 0 */

const nodeServerHttp = require('node:http');
const nodeServerHttps = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const createLiveReloadServer = require('./live-reload-server');
const {
    resolveProjectRoot,
    createStorefrontRequire,
} = require('./runtime-paths');

const projectRootPath = resolveProjectRoot(__dirname);
const storefrontRequire = createStorefrontRequire(projectRootPath);
const { createProxyMiddleware } = storefrontRequire('http-proxy-middleware');

// Match core `npm run hot-proxy` behavior.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.MODE = process.env.MODE || 'hot';

const proxyPort = Number(process.env.STOREFRONT_PROXY_PORT) || 9998;
const assetPort = Number(process.env.STOREFRONT_ASSETS_PORT) || 9999;
const shouldOpenBrowser = process.env.SHOPWARE_STOREFRONT_OPEN_BROWSER !== '0';
const noOp = () => {};

const themeFilesConfigPath = path.resolve(projectRootPath, 'var/theme-files.json');
const themeFiles = require(themeFilesConfigPath);
const domainUrl = new URL(themeFiles.domainUrl);
const themeUrl = new URL(`${domainUrl.protocol}//${domainUrl.host}`);

const appUrlEnv = themeUrl ? themeUrl : new URL(process.env.APP_URL);
const keyPath = process.env.STOREFRONT_HTTPS_KEY_FILE || `${process.env.CAROOT}/${themeUrl.hostname}-key.pem`;
const certPath = process.env.STOREFRONT_HTTPS_CERTIFICATE_FILE || `${process.env.CAROOT}/${themeUrl.hostname}.pem`;
const skipSslCerts = process.env.STOREFRONT_SKIP_SSL_CERT === 'true';
const sslFilesFound = (fs.existsSync(keyPath) && fs.existsSync(certPath));

const proxyProtocol = (appUrlEnv.protocol === 'https:' && sslFilesFound || skipSslCerts) ? 'https:' : 'http:';
const proxyUrlEnv = new URL(process.env.PROXY_URL || `${proxyProtocol}//${appUrlEnv.hostname}:${proxyPort}`);

const appOriginWithSlashPattern = new RegExp(`${escapeRegExp(`${appUrlEnv.origin}/`)}`, 'g');
const proxyMediaPattern = new RegExp(`${escapeRegExp(`${proxyUrlEnv.origin}/media/`)}`, 'g');
const proxyThumbnailPattern = new RegExp(`${escapeRegExp(`${proxyUrlEnv.origin}/thumbnail/`)}`, 'g');
const lineItemRedirectPattern = /content="0;url='\/checkout\/offcanvas'"/g;
const profilerPattern = /http[s]?\\u003A\\\/\\\/[\w.]*(:\d*|\\u003A\d*)?\\\/_wdt/gm;
const xdebugIgnorePattern = /new\s*URL\(url\);\s*url\.searchParams\.set\('XDEBUG_IGNORE'/gm;
const hotProxyPathPattern = /\/_webpack_hot_proxy_\//g;

const baseProxyOptions = {
    appPort: Number(appUrlEnv.port) || undefined,
    host: appUrlEnv.host,
    proxyHost: proxyUrlEnv.host,
    proxyPort: proxyPort,
    secure: appUrlEnv.protocol === 'https:' && sslFilesFound && !skipSslCerts,
    target: appUrlEnv.origin,
    autoRewrite: true,
    followRedirects: false,
    changeOrigin: true,
    headers: {
        host: appUrlEnv.host,
        'hot-reload-mode': 'true',
        'accept-encoding': 'identity',
    },
    cookieDomainRewrite: {
        '*': '',
    },
    cookiePathRewrite: {
        '*': '',
    },
};

function onProxyReq(proxyReq, req) {
    const requestUrl = req.url || '';

    if (requestUrl.indexOf('/sockjs-node/') === 0 || requestUrl.indexOf('hot-update.json') !== -1 || requestUrl.indexOf('hot-update.js') !== -1) {
        proxyReq.host = '127.0.0.1';
        proxyReq.port = assetPort;
    }
}

function onProxyError(err, req, res) {
    console.error(err);

    if (err.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
        console.error('Make sure that node.js trusts the provided certificate. Set NODE_EXTRA_CA_CERTS for this.');
        console.error(`Try to start again with NODE_EXTRA_CA_CERTS="${certPath}" set.`);
        process.exit(1);
    }

    if (err.code === 'SSL_ERROR_NO_CYPHER_OVERLAP') {
        console.error('Try to start watcher again with specific path to https (key and crt) files like this:');
        console.error('STOREFRONT_HTTPS_KEY_FILE=/var/www/html/.../certs/shopware.key STOREFRONT_HTTPS_CERTIFICATE_FILE=/var/www/html/../certs/shopware.crt composer run watch:storefront');
        process.exit(1);
    }

    if (err.code === 'ENOTFOUND') {
        console.error('The domain could not be resolved. Make sure that the domain is correct in DEVENV/DDEV.');
        console.error('And if this is a custom domain, make sure that the domain is set in your /etc/hosts file.');
        process.exit(1);
    }

    res.writeHead(500, {
        'Content-Type': 'text/plain',
    });
    res.end('Something went wrong. Check the console for more information.');
}

const passthroughProxy = createProxyMiddleware({
    ...baseProxyOptions,
    selfHandleResponse: false,
    on: {
        proxyReq: onProxyReq,
        error: onProxyError,
    },
});

const rewriteProxy = createProxyMiddleware({
    ...baseProxyOptions,
    selfHandleResponse: true,
    on: {
        proxyReq: onProxyReq,
        proxyRes: (proxyRes, req, res) => {
            const requestUrl = req.url || '';

            applyProxyHeaders(proxyRes, res);

            if (requestUrl.indexOf('.svg') !== -1) {
                res.setHeader('Content-Type', 'image/svg+xml');
            }

            const chunks = [];
            proxyRes.on('data', (chunk) => {
                chunks.push(chunk);
            });
            proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString();

                if (isLineItemRequest(requestUrl)) {
                    body = body.replace(lineItemRedirectPattern, 'content="0;url=\'?offcanvas=1\'"');
                    res.removeHeader('content-length');
                    res.end(body);
                    return;
                }

                if (requestUrl.indexOf('offcanvas=1') !== -1) {
                    body = body.concat(openOffCanvasScript());
                }

                body = body
                    .replace(hotProxyPathPattern, `${proxyUrlEnv.protocol}//${proxyUrlEnv.hostname}:${assetPort}/`)
                    .replace(appOriginWithSlashPattern, `${proxyUrlEnv.origin}/`)
                    .replace(proxyMediaPattern, `${appUrlEnv.origin}/media/`)
                    .replace(proxyThumbnailPattern, `${appUrlEnv.origin}/thumbnail/`)
                    .replace(profilerPattern, '/_wdt')
                    .replace(xdebugIgnorePattern, 'new URL(window.location.protocol+\'//\'+window.location.host+url);                url.searchParams.set(\'XDEBUG_IGNORE\'');

                res.removeHeader('content-length');
                res.end(body);
            });
        },
        error: onProxyError,
    },
});

const proxy = (req, res) => {
    if (requiresResponseRewrite(req)) {
        rewriteProxy(req, res, noOp);
        return;
    }

    passthroughProxy(req, res, noOp);
};

if (appUrlEnv.protocol === 'https:' && !sslFilesFound) {
    console.error('Could not find the key and certificate files.');
    console.error('Make sure that the environment variables STOREFRONT_HTTPS_KEY_FILE and STOREFRONT_HTTPS_CERTIFICATE_FILE are set correctly.');
    console.error('If you use a TLS proxy (like in DDEV Shopware 6 setup), you can ignore this message.');
}

const sslOptions = proxyUrlEnv.protocol === 'https:' && skipSslCerts === false ? {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
} : {};

const server = createLiveReloadServer(sslOptions).catch((e) => {
    console.error(e);
    console.error('Could not start the live server with the provided certificate files, falling back to http server.');
    return createLiveReloadServer({});
});

server.then(() => {
    console.log('############');
    console.log(`Default TWIG Storefront: ${appUrlEnv.origin}`);
    console.log(`Proxy server hot reload: ${proxyUrlEnv.origin}`);
    console.log('############');

    if (proxyUrlEnv.protocol === 'https:' && skipSslCerts === false) {
        try {
            const httpsServer = nodeServerHttps.createServer(sslOptions, proxy);
            listenProxyServer(httpsServer, 'https');
        } catch (e) {
            console.error(e);
            console.error('Could not start the proxy server with the provided certificate files, falling back to http server.');
            proxyUrlEnv.protocol = 'http:';
        }
    }

    if (proxyUrlEnv.protocol === 'http:' || skipSslCerts === true) {
        const httpServer = nodeServerHttp.createServer(proxy);
        listenProxyServer(httpServer, 'http', skipSslCerts);
    }

    console.log('############');
    console.log('\n');

    if (shouldOpenBrowser) {
        openBrowserWithUrl(`${proxyUrlEnv.origin}`);
        return;
    }

    console.log(`Auto-open browser disabled. Open manually: ${proxyUrlEnv.origin}`);
});

function isDocumentRequest(req) {
    const secFetchDest = (req.headers['sec-fetch-dest'] || req.headers['Sec-Fetch-Dest'] || '').toLowerCase();
    const secFetchMode = (req.headers['sec-fetch-mode'] || req.headers['Sec-Fetch-Mode'] || '').toLowerCase();
    const acceptHeader = typeof req.headers.accept === 'string'
        ? req.headers.accept.toLowerCase()
        : '';

    return (
        secFetchDest === 'document' ||
        secFetchMode === 'navigate' ||
        acceptHeader.includes('text/html')
    );
}

function openOffCanvasScript() {
    return '<script>document.addEventListener("DOMContentLoaded", () => { setTimeout(() => { if (!document.querySelector(".header-cart-total").textContent.includes("0.00")) { document.querySelector(".header-cart").click(); } }, 500); });</script>';
}

function applyProxyHeaders(proxyRes, res) {
    if (proxyRes.statusCode) {
        res.statusCode = proxyRes.statusCode;
    }

    for (const [header, value] of Object.entries(proxyRes.headers || {})) {
        if (typeof value !== 'undefined') {
            res.setHeader(header, value);
        }
    }
}

function openBrowserWithUrl(url) {
    const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(start, [url], { stdio: 'ignore', detached: true });
    child.on('error', error => console.log('Unable to open browser! Details:', error));
}

function isLineItemRequest(requestUrl) {
    return (requestUrl || '').indexOf('/checkout/line-item/') !== -1;
}

function isOffcanvasRequest(requestUrl) {
    return ['/widgets/menu/offcanvas', '/checkout/offcanvas'].some(requestPath => (requestUrl || '').includes(requestPath));
}

function requiresResponseRewrite(req) {
    const requestUrl = req.url || '';

    if (isLineItemRequest(requestUrl)) {
        return true;
    }

    if (isOffcanvasRequest(requestUrl)) {
        return true;
    }

    return isDocumentRequest(req);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listenProxyServer(server, protocol, skipSslMessage = false) {
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`Proxy port ${proxyPort} is already in use.`);
            console.error('Stop the existing watcher process or use a different STOREFRONT_PROXY_PORT.');
            process.exit(1);
        }

        console.error(`Unable to start ${protocol} proxy server:`, error);
        process.exit(1);
    });

    server.listen(proxyPort, () => {
        if (protocol === 'https') {
            console.log('Proxy uses the https schema, with ssl certificate files.');
            return;
        }

        console.log(`Proxy uses the http schema${skipSslMessage ? ' (SSL certificates are skipped).' : '.'}`);
    });
}

'use strict';

const { protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const { resolveServable } = require('./dataFiles');

// app-data://files/<relative path> serves the logo, startup sound and product images from
// data/ without giving the renderer any filesystem access.
const SCHEME = 'app-data';

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function handleProtocol(paths) {
  protocol.handle(SCHEME, (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const file = resolveServable(paths, rel);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

module.exports = { SCHEME, registerScheme, handleProtocol };

import { RelayRoom } from './relay-room.js';
import { ASSETS, CLIENT_HTML } from './generated-assets.js';

export { RelayRoom };

function response(body, contentType, cacheControl = 'no-store') {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return response(json({
        status: 'ok',
        version: 'v3',
        time: new Date().toISOString(),
      }), 'application/json;charset=utf-8');
    }

    if (path === '/' || path === '/index.html') {
      return response(CLIENT_HTML, 'text/html;charset=utf-8');
    }

    const asset = ASSETS[path];
    if (asset) {
      return response(asset.body, asset.type);
    }

    const match = path.match(/^\/connect\/([A-Za-z0-9_-]{8,128})$/);
    if (match) {
      return env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(match[1])).fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};

function json(data) {
  return JSON.stringify(data);
}

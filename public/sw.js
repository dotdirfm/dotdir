/**
 * Service worker: virtual FS for extension scripts and assets (Web mode).
 * Intercepts /vfs/<key>/... and serves from an in-memory map.
 * Main thread sends { type: 'faraday-vfs-mount', base: '/vfs/<key>/', files: { "path": "content" } }.
 */
const vfs = new Map();

function normalizePathname(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/\/+/g, '/');
  } catch {
    return pathname.replace(/\/+/g, '/');
  }
}

function mimeForPath(pathname) {
  const ext = pathname.split('.').pop()?.toLowerCase() || '';
  if (ext === 'json') return 'application/json';
  if (ext === 'css') return 'text/css';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  return 'text/javascript';
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const { type, base, files } = event.data || {};
  if (type === 'faraday-vfs-mount' && base && files && typeof files === 'object') {
    const baseNorm = base.endsWith('/') ? base : base + '/';
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue;
      const urlPath = normalizePathname(baseNorm + path.replace(/^\/+/, ''));
      vfs.set(urlPath, content);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/vfs/')) return;
  const pathname = normalizePathname(url.pathname);
  const content = vfs.get(pathname);
  if (content === undefined) {
    event.respondWith(new Response('Not found', { status: 404, statusText: pathname }));
    return;
  }
  event.respondWith(
    new Response(content, {
      headers: { 'Content-Type': mimeForPath(pathname) },
    })
  );
});

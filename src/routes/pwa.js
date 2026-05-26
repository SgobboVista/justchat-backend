function registerPwaRoutes(app, { sharp }) {
const PWA_CACHE_NAME = 'justchat-shell-v2';
const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="116" fill="#0f766e"/>
    <path fill="#ffffff" d="M117 142c0-29 24-53 53-53h172c29 0 53 24 53 53v147c0 29-24 53-53 53H229l-76 65c-14 12-36 2-36-17V142z"/>
    <path fill="#0f766e" d="M185 189h142a14 14 0 1 1 0 28H185a14 14 0 1 1 0-28zm0 55h99a14 14 0 1 1 0 28h-99a14 14 0 1 1 0-28z"/>
</svg>`;

app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').send({
        name: 'JustChat',
        short_name: 'JustChat',
        description: 'Private Chats mit JustChat',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f0f4f8',
        theme_color: '#0f766e',
        icons: [
            { src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    });
});

app.get('/pwa-icon-:size(180|192|512).png', async (req, res, next) => {
    try {
        const size = Number(req.params.size);
        const icon = await sharp(Buffer.from(PWA_ICON_SVG)).resize(size, size).png().toBuffer();
        res.set('Cache-Control', 'public, max-age=604800, immutable');
        return res.type('png').send(icon);
    } catch (error) {
        return next(error);
    }
});

app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').send(`
const CACHE_NAME = '${PWA_CACHE_NAME}';
const APP_SHELL = ['/', '/manifest.webmanifest', '/pwa-icon-192.png', '/pwa-icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
    if (event.request.mode === 'navigate' && url.pathname === '/') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
                    }
                    return response;
                })
                .catch(() => caches.match('/'))
        );
    }
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    event.waitUntil(self.registration.showNotification(data.title || 'JustChat News', {
        body: data.body || 'Es gibt ein neues Update.',
        icon: '/pwa-icon-192.png',
        badge: '/pwa-icon-192.png',
        data: { url: data.url || '/?tab=news' },
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data && event.notification.data.url || '/?tab=news';
    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        for (const client of windows) {
            if ('focus' in client) {
                client.navigate(url);
                return client.focus();
            }
        }
        return clients.openWindow(url);
    }));
});
`);
});

}

module.exports = { registerPwaRoutes };

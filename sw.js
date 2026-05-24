/* =========================================================
   EduCall Service Worker — PWA Cache & Offline Support
   ========================================================= */

const CACHE_NAME    = 'educall-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js',
  'https://cdn.socket.io/4.7.2/socket.io.min.js',
];

// ── Instalación: cachear recursos estáticos ───────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando EduCall PWA...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cachear assets locales siempre; los externos con tolerancia a errores
      const local   = STATIC_ASSETS.filter(u => u.startsWith('/'));
      const external = STATIC_ASSETS.filter(u => !u.startsWith('/'));

      await cache.addAll(local).catch(e => console.warn('[SW] Error cacheando locales:', e));
      await Promise.allSettled(external.map(url => cache.add(url)));
      console.log('[SW] Assets cacheados');
    })
  );
  self.skipWaiting();
});

// ── Activación: limpiar caches viejos ────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activando EduCall PWA...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Eliminando cache viejo:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: estrategia Network-first con fallback a cache ─────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar peticiones de Socket.io y PeerJS (tiempo real — no cachear)
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/peerjs') ||
      url.pathname.startsWith('/api/')) {
    return; // dejar pasar sin interceptar
  }

  // Para todo lo demás: Network-first, fallback a cache
  event.respondWith(
    fetch(request)
      .then(response => {
        // Solo cachear respuestas válidas
        if (response && response.status === 200 && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).then(cached => {
          if (cached) return cached;
          // Fallback para navegación: devolver index.html
          if (request.mode === 'navigate') return caches.match('/index.html');
          return new Response('Sin conexión', { status: 503 });
        });
      })
  );
});

// ── Push Notifications (futuro) ───────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'EduCall', body: 'Tienes una notificación' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});

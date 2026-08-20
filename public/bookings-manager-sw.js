// public/bookings-manager-sw.js
//
// Minimal service worker, scoped only to /bookings-manager. Its only
// real job is to exist and register a fetch handler -- Chrome/Edge
// require this for the "Add to Home Screen" / install prompt to show
// up at all, even though this tool otherwise needs a live network
// connection (appointment data is never cached; showing a stale
// schedule or stale appointment list would be actively harmful for a
// clinic booking tool).
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler -- required for installability, but does
// not cache or intercept anything. Every request still goes to the
// network exactly as if there were no service worker at all.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

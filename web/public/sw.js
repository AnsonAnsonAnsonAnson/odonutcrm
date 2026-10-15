// Web push for members who use the web card (mainly Android / desktop browsers, and iOS 16.4+ home-screen apps).
self.addEventListener('push', (event) => {
  let data = { title: 'O! Donut', body: '', url: '/me' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/me';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      for (const w of wins) if ('focus' in w) { w.navigate(url); return w.focus(); }
      return self.clients.openWindow(url);
    }),
  );
});

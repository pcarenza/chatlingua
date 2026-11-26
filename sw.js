// Service worker: shows incoming-call notifications delivered by Web Push.
const origin = self.location.origin;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const closeRing = async room => {
  for (const notification of await self.registration.getNotifications({ tag: 'ring-' + room })) notification.close();
};

self.addEventListener('push', event => {
  let message;
  try { message = event.data?.json(); } catch { return; }
  if (!message || !/^[a-f0-9]{36}$/.test(message.room ?? '')) return;
  if (message.type === 'cancel') return event.waitUntil(closeRing(message.room));
  if (message.type !== 'ring') return;
  const name = String(message.name ?? '').slice(0, 60) || 'Someone';
  event.waitUntil((async () => {
    await self.registration.showNotification('Incoming call from ' + name, {
      body: 'ChatLingua video call',
      tag: 'ring-' + message.room,
      renotify: true,
      requireInteraction: true,
      data: { room: message.room },
      actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
    });
    // Best effort: dismiss the notification when the ring runs out.
    await new Promise(resolve => setTimeout(resolve, 45_000));
    await closeRing(message.room);
  })());
});

self.addEventListener('notificationclick', event => {
  const room = event.notification.data?.room;
  event.notification.close();
  if (!/^[a-f0-9]{36}$/.test(room ?? '')) return;
  if (event.action === 'decline') {
    event.waitUntil(fetch('/api/contacts/decline', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room }),
    }).catch(() => {}));
    return;
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(origin));
    if (existing) {
      await existing.focus().catch(() => {});
      existing.postMessage({ type: 'answer', room });
    } else {
      await self.clients.openWindow('/?answer=' + room);
    }
  })());
});

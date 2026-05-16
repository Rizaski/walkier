/* WalkieR service worker — notifications when the app is in the background */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});

const NOTIFY_ICON = "/icons/icon.svg";

function showNotify(title, body, tag) {
  return self.registration.showNotification(title, {
    body,
    tag: tag || "walkier-audio",
    renotify: true,
    icon: NOTIFY_ICON,
    badge: NOTIFY_ICON,
    vibrate: [120, 60, 120],
    silent: false,
    data: { url: "/" },
  });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "walkier-notify") return;
  const { title, body, tag } = data;
  event.waitUntil(showNotify(title, body, tag));
});

/* WalkieR — show notifications while the app tab is open in background */

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

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "walkier-notify") return;
  const { title, body, tag } = data;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: tag || "walkier-audio",
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: "/" },
    })
  );
});

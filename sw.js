// Guarda o app no aparelho para abrir mesmo sem internet.
// Sempre tenta a versão nova primeiro; sem conexão, usa a cópia guardada.
const CACHE = 'agenda-v16';
const ARQUIVOS = ['./', './index.html', './privacidade.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Só arquivos do próprio app; a secretária (outro endereço) precisa de internet de qualquer jeito
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});

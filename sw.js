/* beisuas Service Worker
   作用：满足浏览器「可安装（installable）」条件，并提供 fetch 事件处理。
   不做页面缓存：站点内容由服务端按语言直出，缓存 HTML 会导致语言/文章更新后看到旧页面。
   仅在离线且请求的是导航页时给出一句离线提示。 */

const OFFLINE_HTML = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Нет подключения — beisuas</title>'
  + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#f6f8fb;color:#22282f;font-family:-apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px}'
  + 'h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#5b6470;line-height:1.7}</style></head>'
  + '<body><div><h1>Нет подключения</h1><p>Проверьте интернет и обновите страницу.<br>请检查网络后刷新页面 · Please check your connection.</p></div></body></html>';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  // 只兜底导航请求：断网时给离线提示，其余请求保持浏览器默认行为（不缓存、不拦截）
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(OFFLINE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    })
  );
});

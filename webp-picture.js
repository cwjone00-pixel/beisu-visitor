/**
 * 图片 WebP 降级工具：站点内的 JPG/PNG 都有构建期生成的同名 .webp，
 * 这里统一输出 <picture> + <source type="image/webp">，不支持 WebP 的浏览器
 * 会忽略 source，自动回退 <img src> 里的原图。
 * picture 使用 display:contents，保持原有布局与 CSS 选择器不变。
 */
(function () {
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 仅本地静态 JPG/PNG 参与替换；外链、data:、blob:、已为 WebP 的地址原样返回 */
  function webpOf(src) {
    var s = String(src || '');
    if (!s || /^(data:|blob:|https?:\/\/|\/\/)/i.test(s)) return '';
    if (!/\.(jpe?g|png)(?=$|[?#])/i.test(s)) return '';
    return s.replace(/\.(jpe?g|png)(?=$|[?#])/i, '.webp');
  }

  window.webpPicture = function (src, opts) {
    opts = opts || {};
    var attrs = '';
    if (opts.cls) attrs += ' class="' + esc(opts.cls) + '"';
    if (opts.alt != null) attrs += ' alt="' + esc(opts.alt) + '"';
    if (opts.loading) attrs += ' loading="' + esc(opts.loading) + '"';
    if (opts.fetchpriority) attrs += ' fetchpriority="' + esc(opts.fetchpriority) + '"';
    if (opts.attrs) attrs += ' ' + opts.attrs;

    var webp = webpOf(src);
    var img = '<img src="' + esc(src) + '"' + attrs + '>';
    if (!webp) return img;
    return '<picture style="display:contents"><source srcset="' + esc(webp) + '" type="image/webp">' + img + '</picture>';
  };
})();

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // [수정] URL이 없는데 검색어만 있는 경우, 이전 도메인을 찾아 결합
  if (!targetUrl) {
    const q = req.query.query || req.query.q;
    const referer = req.headers.referer;
    if (q && referer && referer.includes('url=')) {
      try {
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        targetUrl = prevUrl.origin + prevUrl.pathname + (prevUrl.search ? prevUrl.search + '&' : '?') + (req.query.query ? 'query=' : 'q=') + encodeURIComponent(q);
      } catch(e) { return res.redirect('/'); }
    } else { return res.redirect('/'); }
  }

  try {
    const urlObj = new URL(targetUrl);
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin 
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const abs = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(abs));
            } catch (e) {}
          }
        });
      };
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('script', 'src'); rewrite('link', 'href');

      const injectScript = `
        <script>
          (function() {
            const currentOrigin = window.location.origin;
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(currentOrigin)) return abs;
                return currentOrigin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // 클릭/폼 전송 가로채기 (캡처링)
            window.addEventListener('click', e => {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault(); e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            window.addEventListener('submit', e => {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentOrigin)) {
                e.preventDefault(); e.stopImmediatePropagation();
                const sp = new URLSearchParams(new FormData(form));
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // [추가] History 조작 가로채기 (구글/레딧 등 SPA 대응)
            const patch = (m) => {
              const org = history[m];
              history[m] = function(s, t, u) {
                if (u && !u.includes(currentOrigin)) {
                  window.location.href = wrap(u);
                } else return org.apply(this, arguments);
              };
            };
            patch('pushState'); patch('replaceState');
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) { res.redirect('/'); }
});

// [핵심 수정] 길 잃은 요청 자동 복구 로직
app.get('*', (req, res) => {
  const referer = req.headers.referer;
  // 만약 이전 페이지가 프록시 내부였다면, 그 도메인을 붙여서 다시 시도
  if (referer && referer.includes('/proxy?url=')) {
    try {
      const urlParams = new URLSearchParams(new URL(referer).search);
      const lastUrl = new URL(urlParams.get('url'));
      const recoveredUrl = lastUrl.origin + req.originalUrl;
      return res.redirect('/proxy?url=' + encodeURIComponent(recoveredUrl));
    } catch (e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Fixed Proxy Active'); });

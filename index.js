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

  // [보정] URL 유실 시 이전 Referer 기반으로 도메인 복구
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
    Object.keys(req.query).forEach(key => { if (key !== 'url') urlObj.searchParams.set(key, req.query[key]); });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 모든 정적 요소 치환
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
      rewrite('img', 'src'); rewrite('link', 'href'); rewrite('script', 'src'); rewrite('a', 'href');

      // 2. [초강력] MutationObserver 기반 실시간 감시 스크립트 주입
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

            // [업그레이드] MutationObserver: 자바스크립트가 링크를 새로 만들 때마다 즉시 감지하여 수정
            const observer = new MutationObserver(() => {
              document.querySelectorAll('a[href]:not([data-proxied]), form[action]:not([data-proxied])').forEach(el => {
                const attr = el.tagName === 'A' ? 'href' : 'action';
                const originalValue = el.getAttribute(attr);
                if (originalValue && !originalValue.includes(currentOrigin)) {
                  el.setAttribute(attr, wrap(originalValue));
                  el.setAttribute('data-proxied', 'true'); // 중복 처리 방지
                }
              });
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // 클릭 및 전송 최우선 가로채기 (이벤트 캡처링 단계)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            window.addEventListener('submit', function(e) {
              const form = e.target;
              if (!form.action.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = wrap(form.action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // History API 조작 감시 (주소창 초기화 방지)
            const patch = (type) => {
              const orig = history[type];
              history[type] = function(s, t, u) {
                if (u && !u.includes(currentOrigin)) {
                  window.location.href = wrap(u);
                  return;
                }
                return orig.apply(this, arguments);
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
  } catch (error) {
    res.redirect('/');
  }
});

// 모든 예외 경로 홈 리다이렉트 (이걸 유지해야 서버가 안 죽음)
app.get('*', (req, res) => { res.redirect('/'); });

app.listen(port, () => { console.log('Fixed Proxy Running'); });

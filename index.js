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

  // 1. 유실된 검색 요청 복구 (이전 페이지 도메인을 기억해서 연결)
  if (!targetUrl) {
    const q = req.query.query || req.query.q || req.query.searchTerm;
    const referer = req.headers.referer;
    if (q && referer && referer.includes('url=')) {
      try {
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        // 이전 도메인에 맞춰 검색 경로 자동 생성
        const searchPath = prevUrl.origin.includes('google') ? '/search?q=' : 
                           prevUrl.origin.includes('naver') ? '/search.naver?query=' : 
                           prevUrl.pathname + '?q=';
        targetUrl = prevUrl.origin + searchPath + encodeURIComponent(q);
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
        'Referer': urlObj.origin,
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 12000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 2. 정적 리소스 주소 모두 치환
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

      // 3. [최후의 수단] 브라우저 내 이동 명령 전체 가로채기
      const injectScript = `
        <script>
          (function() {
            const PROXY_BASE = window.location.origin + '/proxy?url=';
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(window.location.host)) return abs;
                return PROXY_BASE + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // 모든 클릭 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 모든 폼 전송 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const params = new URLSearchParams(new FormData(form));
                window.location.href = wrap(action.split('?')[0] + '?' + params.toString());
              }
            }, true);

            // [핵심] 주소창 조작 시도 감지 시 즉시 프록시로 재진입
            const patch = (method) => {
              const original = history[method];
              history[method] = function(state, title, url) {
                if (url && !url.includes(window.location.host)) {
                  window.location.href = wrap(url);
                  return;
                }
                return original.apply(this, arguments);
              };
            };
            patch('pushState');
            patch('replaceState');

            // 페이지 내에서 발생하는 비정상적인 도메인 이탈 실시간 감시
            setInterval(() => {
              document.querySelectorAll('a[href]:not([data-fixed])').forEach(el => {
                if(!el.href.includes(window.location.host)) {
                  el.href = wrap(el.href);
                  el.setAttribute('data-fixed', 'true');
                }
              });
            }, 1000);
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

// 4. 경로 이탈 복구 (Referer 기반 지능형 리다이렉트)
app.get('*', (req, res) => {
  const referer = req.headers.referer;
  if (referer && referer.includes('url=')) {
    try {
      const prev = new URL(new URL(referer).searchParams.get('url'));
      return res.redirect('/proxy?url=' + encodeURIComponent(prev.origin + req.originalUrl));
    } catch(e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Universal Proxy Shield Active'); });

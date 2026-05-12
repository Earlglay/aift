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
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
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
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              const abs = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(abs));
            } catch (e) {}
          }
        });
      };
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('script', 'src'); rewrite('link', 'href');

      // [핵심] 검색 튕김 방지 및 History API 원천 봉쇄 스크립트
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(window.location.host)) return abs;
                return PROXY_URL + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // 1. History API 무력화 (검색 시 주소창이 원본으로 바뀌는 것 차단)
            const patchHistory = (method) => {
              const original = history[method];
              history[method] = function(state, title, url) {
                if (url && !url.includes(window.location.host)) {
                  // 주소 변경 시도를 가로채서 프록시 주소로 강제 리다이렉트
                  window.location.href = wrap(url);
                  return;
                }
                return original.apply(this, arguments);
              };
            };
            patchHistory('pushState');
            patchHistory('replaceState');

            // 2. 검색 버튼 및 폼 전송 가로채기 (이벤트 캡처링 단계)
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                
                const finalSearchUrl = action.split('?')[0] + '?' + sp.toString();
                window.location.href = wrap(finalSearchUrl);
              }
            }, true);

            // 3. 지연 로딩되는 검색 결과 링크들 보호 (OneLink 스타일)
            setInterval(() => {
              document.querySelectorAll('a[href]:not([data-proxy])').forEach(el => {
                if(!el.href.includes(window.location.host)) {
                  el.setAttribute('data-proxy', 'true');
                  el.href = wrap(el.href);
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

// 정적 파일 외의 모든 요청은 404 처리하여 튕김 루프 방지
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/proxy') return next();
  res.status(404).send('Not Found');
});

app.listen(port, () => { console.log('Search-Fix Proxy Active'); });

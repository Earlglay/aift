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

  // [수정] 네이버 강제 연결 로직 삭제 -> 현재 페이지 기반 검색 복구
  if (!targetUrl) {
    const referer = req.headers.referer;
    const q = req.query.query || req.query.q;
    
    if (q && referer && referer.includes('url=')) {
      try {
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        // 이전 도메인 주소에 검색어만 붙여서 다시 요청
        targetUrl = prevUrl.origin + prevUrl.pathname + (prevUrl.search ? prevUrl.search + '&' : '?') + (req.query.query ? 'query=' : 'q=') + encodeURIComponent(q);
      } catch(e) {
        return res.redirect('/');
      }
    } else {
      return res.redirect('/');
    }
  }

  try {
    const urlObj = new URL(targetUrl);
    // 모든 쿼리 파라미터 유지
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 모든 경로 치환
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

      // 폼 가로채기 스크립트 (중립 버전)
      const injectScript = `
        <script>
          (function() {
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(window.location.host)) return abs;
                return window.location.origin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                window.location.href = wrap(a.href);
              }
            }, true);

            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);
            
            // History API 보호
            const patch = (m) => {
              const orig = history[m];
              history[m] = function(s, t, u) {
                if (u && !u.includes(window.location.host)) {
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

app.get('*', (req, res) => {
  res.redirect('/');
});

app.listen(port, () => { console.log('Proxy Fixed'); });

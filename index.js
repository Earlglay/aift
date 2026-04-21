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

  // 검색어 파라미터 통합 처리 (구글/네이버/레딧 등)
  if (!targetUrl) {
    const q = req.query.query || req.query.q || req.query.searchTerm;
    if (q) {
      // 기본값은 네이버 검색으로 설정 (필요시 변경 가능)
      targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
    } else {
      return res.redirect('/');
    }
  }

  try {
    const urlObj = new URL(targetUrl);
    // 모든 쿼리를 합침
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    // 쿠키 전달 (로그인 등 세션 유지에 필요)
    const setCookie = response.headers['set-cookie'];
    if (setCookie) res.set('set-cookie', setCookie);

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 경로 치환
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
      
      // 폼 처리
      $('form').attr('action', '/proxy').attr('method', 'GET');

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

            // 1. 도메인 속이기 (네이버 튕김 방지)
            try { Object.defineProperty(document, 'domain', { get: () => 'naver.com' }); } catch(e) {}

            // 2. 모든 클릭/이동 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 3. 구글/레딧 등 SPA 사이트용 History API 가로채기
            const patchHistory = (type) => {
              const orig = history[type];
              history[type] = function(state, title, url) {
                if (url && !url.includes(currentOrigin)) {
                  window.location.href = wrap(url);
                  return;
                }
                return orig.apply(this, arguments);
              };
            };
            patchHistory('pushState');
            patchHistory('replaceState');

            // 4. 폼 전송 가로채기 (검색 기능)
            window.addEventListener('submit', function(e) {
              const form = e.target;
              if (!form.action.includes(currentOrigin)) {
                e.preventDefault();
                const action = new URL(form.action || window.location.href, window.location.href).href;
                const sp = new URLSearchParams(new FormData(form));
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);
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

// 이탈 방지 와일드카드
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

app.listen(port, () => { console.log('Proxy Deployment Active'); });

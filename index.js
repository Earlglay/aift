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

  // 1. 검색어 자동 보정
  if (!targetUrl && (req.query.query || req.query.q)) {
    const q = req.query.query || req.query.q;
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
  }

  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.naver.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 모든 경로 리라이팅
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

      // [초강력] JS 보안 우회 스크립트
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

            // 1. 도메인 속이기 (네이버 JS가 도메인을 체크할 때 네이버인 척 함)
            try {
              Object.defineProperty(document, 'domain', { get: () => 'naver.com' });
            } catch(e) {}

            // 2. 모든 클릭/이동 가로채기 (최우선 순위)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href) {
                const target = a.href;
                if (!target.includes(window.location.host)) {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  window.location.href = wrap(target);
                }
              }
            }, true);

            // 3. 비동기 이동(Location 조작) 감시 및 가로채기
            const orgPush = history.pushState;
            const orgReplace = history.replaceState;
            history.pushState = function(s, t, u) { return u ? (window.location.href = wrap(u)) : orgPush.apply(this, arguments); };
            history.replaceState = function(s, t, u) { return u ? (window.location.href = wrap(u)) : orgReplace.apply(this, arguments); };

            // 4. 폼 전송 가로채기
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
  const referer = req.headers.referer;
  if (referer && referer.includes('url=')) {
    try {
      const prevUrl = new URL(new URL(referer).searchParams.get('url'));
      return res.redirect('/proxy?url=' + encodeURIComponent(prevUrl.origin + req.originalUrl));
    } catch(e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Final Proxy Deployment Active'); });

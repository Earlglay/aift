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

  // 범용 검색어 보정
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
        'Referer': new URL(targetUrl).origin
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. HTML 태그 경로 치환 (기본)
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

      // 2. [초강력] 자바스크립트 엔진 레벨 가로채기
      const injectScript = `
        <script>
          (function() {
            const origin = window.location.origin;
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith(origin)) return u;
              try { return origin + '/proxy?url=' + encodeURIComponent(new URL(u, window.location.href).href); } catch(e) { return u; }
            };

            // [클릭] 캡처링 단계에서 원천 봉쇄
            window.addEventListener('click', e => {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(origin)) {
                e.preventDefault(); e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            // [비동기] Fetch 및 XHR 가로채기 (네이버의 내부 통신 감시)
            const orgFetch = window.fetch;
            window.fetch = function(r, i) {
              if(typeof r === 'string') r = wrap(r);
              return orgPush.apply(this, arguments);
            };

            // [주소창] History API 조작 감시 (튕김 방지 핵심)
            const patchProp = (obj, prop) => {
              const org = obj[prop];
              obj[prop] = function(s, t, u) {
                if(u) window.location.href = wrap(u);
                else return org.apply(this, arguments);
              };
            };
            patchProp(history, 'pushState');
            patchProp(history, 'replaceState');

            // [폼] 전송 가로채기
            window.addEventListener('submit', e => {
              const f = e.target;
              const act = new URL(f.action || window.location.href, window.location.href).href;
              if(!act.includes(origin)) {
                e.preventDefault(); e.stopImmediatePropagation();
                const params = new URLSearchParams(new FormData(f));
                window.location.href = wrap(act.split('?')[0] + '?' + params.toString());
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

// [와일드카드] 길 잃은 요청 자동 복원
app.get('*', (req, res) => {
  const path = req.path;
  if (['/proxy', '/'].includes(path) || path.includes('.')) return;

  const referer = req.headers.referer;
  let domain = 'https://www.naver.com';
  if (referer && referer.includes('url=')) {
    try {
      domain = new URL(decodeURIComponent(new URL(referer).searchParams.get('url'))).origin;
    } catch(e) {}
  }
  res.redirect('/proxy?url=' + encodeURIComponent(domain + req.originalUrl));
});

app.listen(port, () => { console.log('Final Engine Proxy Running'); });

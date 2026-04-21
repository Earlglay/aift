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

  // 검색어 보정 (네이버, 구글 등 범용)
  if (!targetUrl && (req.query.query || req.query.q)) {
    const q = req.query.query || req.query.q;
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
  }

  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    // 모든 쿼리 파라미터를 강제 병합하여 유실 방지
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.naver.com/',
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

      // 모든 경로 치환 (이미지, 스크립트 등)
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

      // [핵심] 클라이언트 단 보안 우회 및 가로채기
      const injectScript = `
        <script>
          (function() {
            const currentOrigin = window.location.origin;
            const wrap = (u) => {
              if(!u || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(currentOrigin)) return abs;
                return currentOrigin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // 1. 모든 클릭 캡처링 (가장 먼저 실행되도록 true 설정)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 2. 폼 전송 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const formData = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of formData.entries()) sp.append(k, v);
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // 3. 네이버/구글의 History API 조작 원천 차단
            const noop = () => {};
            // history.pushState = noop; // 필요 시 주석 해제하여 History API 아예 무력화
            // history.replaceState = noop;
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
  // 모르는 주소로 튕겼을 때 마지막 Referer를 보고 자동 복구 시도
  const referer = req.headers.referer;
  if (referer && referer.includes('url=')) {
    try {
      const prevUrl = new URL(new URL(referer).searchParams.get('url'));
      return res.redirect('/proxy?url=' + encodeURIComponent(prevUrl.origin + req.originalUrl));
    } catch(e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Proxy Fixed and Running'); });

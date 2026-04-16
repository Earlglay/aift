const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // URL 파라미터가 유실되었을 때 Referer를 통해 목적지 추론
  if (!targetUrl && req.headers.referer) {
    try {
      const refUrl = new URL(req.headers.referer);
      const prevTarget = refUrl.searchParams.get('url');
      if (prevTarget) {
        targetUrl = new URL(req.originalUrl, new URL(prevTarget).origin).href;
      }
    } catch (e) {}
  }

  if (!targetUrl) return res.redirect('/');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': new URL(targetUrl).origin,
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

      // 1. 모든 리소스 주소 치환
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

      // 2. 폼 처리
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        const absAction = new URL(action, targetUrl).href;
        $(el).attr('action', '/proxy').attr('method', 'GET').removeAttr('target');
        $(el).find('input[name="url"]').remove();
        $(el).prepend(`<input type="hidden" name="url" value="${absAction}">`);
      });

      // 3. [초강력] 브라우저 제어 스크립트 주입
      const injectScript = `
        <script>
          (function() {
            // 주소창 강제 고정 및 History API 무력화 (네이버의 메인 튕기기 방지)
            const proxyWrap = (url) => '/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href);
            
            // 모든 클릭 이벤트 최우선 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = proxyWrap(a.href);
              }
            }, true);

            // History API 가로채기 (네이버가 주소를 몰래 바꾸지 못하게 함)
            const originalPush = history.pushState;
            history.pushState = function(state, title, url) {
              if (url && !url.includes(window.location.host)) {
                return window.location.href = proxyWrap(url);
              }
              return originalPush.apply(this, arguments);
            };

            // 폼 전송 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              if (!form.action.includes(window.location.host)) {
                e.preventDefault();
                const action = new URL(form.action, window.location.href).href;
                const sp = new URLSearchParams(new FormData(form));
                window.location.href = proxyWrap(action + (action.includes('?') ? '&' : '?') + sp.toString());
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
    res.redirect('/'); // 에러 발생 시 에러 페이지 대신 홈으로 안전하게 이동
  }
});

// 4. [와일드카드] 길 잃은 모든 요청을 원본 도메인으로 자동 복구
app.get('*', (req, res) => {
  const path = req.path;
  if (path === '/proxy' || path === '/') return res.redirect('/');

  // 이전에 어디 있었는지(Referer)를 보고 도메인을 추측하여 다시 프록시로 넣음
  const referer = req.headers.referer;
  let domain = 'https://www.naver.com'; // 기본값

  if (referer && referer.includes('url=')) {
    try {
      const refUrl = new URL(referer);
      const prevUrl = refUrl.searchParams.get('url');
      if (prevUrl) domain = new URL(prevUrl).origin;
    } catch (e) {}
  }

  const recoveredUrl = domain + req.originalUrl;
  res.redirect('/proxy?url=' + encodeURIComponent(recoveredUrl));
});

app.listen(port, () => { console.log('Proxy Server Running'); });

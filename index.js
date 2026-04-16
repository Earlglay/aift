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

  // [보정 1] url 파라미터가 없는데 query만 들어온 경우 (검색 시도 상황)
  if (!targetUrl && req.query.query) {
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
  }

  if (!targetUrl) return res.redirect('/');

  try {
    // [보정 2] 현재 들어온 모든 쿼리 파라미터를 타겟 URL에 강제로 합침
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') {
        urlObj.searchParams.set(key, req.query[key]);
      }
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.naver.com/'
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 기본 경로 치환
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

      // 2. [핵심] 브라우저 내 '전송 가로채기' 스크립트 주입
      const injectScript = `
        <script>
          (function() {
            // 모든 클릭 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
              }
            }, true);

            // [집중 수정] 모든 폼(검색창) 전송 가로채기
            window.addEventListener('submit', function(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              const formData = new FormData(form);
              const params = new URLSearchParams();
              
              // 폼 안의 모든 입력값을 주소창 파라미터로 변환
              for (const [key, value] of formData.entries()) {
                params.append(key, value);
              }
              
              // 최종 목적지 구성 (우리 프록시 주소 + 네이버 검색 주소 + 검색어들)
              const finalTarget = action.split('?')[0] + '?' + params.toString();
              window.location.href = '/proxy?url=' + encodeURIComponent(finalTarget);
            }, true);
            
            // History API 보호 (메인 튕김 방지)
            const originalPush = history.pushState;
            history.pushState = function(state, title, url) {
              if (url && !url.includes(window.location.host)) {
                return window.location.href = '/proxy?url=' + encodeURIComponent(new URL(url, window.location.href).href);
              }
              return originalPush.apply(this, arguments);
            };
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      // 3. HTML 내의 폼 속성 무력화 (JS가 가로채기 쉽게)
      $('form').removeAttr('onsubmit').attr('action', 'javascript:void(0);');

      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) {
    res.redirect('/');
  }
});

// [와일드카드] 모든 이탈 경로 강제 복구
app.get('*', (req, res) => {
  const path = req.path;
  if (['/proxy', '/'].includes(path) || path.includes('.')) return res.redirect('/');

  const referer = req.headers.referer;
  let domain = 'https://www.naver.com';
  if (referer && referer.includes('url=')) {
    try {
      const prevUrl = new URL(referer).searchParams.get('url');
      if (prevUrl) domain = new URL(prevUrl).origin;
    } catch (e) {}
  }
  res.redirect('/proxy?url=' + encodeURIComponent(domain + req.originalUrl));
});

app.listen(port, () => { console.log('Final Proxy Server Running'); });

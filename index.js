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

  // [수정] 검색 파라미터 강제 병합
  if (targetUrl) {
    try {
      const urlObj = new URL(targetUrl);
      Object.keys(req.query).forEach(key => {
        if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
      });
      targetUrl = urlObj.href;
    } catch (e) {}
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // 모든 상대 경로를 프록시 절대 경로로 변환
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const absolute = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(absolute));
            } catch (e) {}
          }
        });
      };
      rewrite('img', 'src'); rewrite('link', 'href'); rewrite('script', 'src'); rewrite('a', 'href');

      // [핵심] 클라이언트 단에서 실행될 초강력 가로채기 스크립트
      const injectScript = `
        <script>
          (function() {
            // 1. 모든 클릭 가로채기 (네이버의 동적 클릭 포함)
            document.addEventListener('click', function(e) {
              var el = e.target.closest('a');
              if (el && el.href && !el.href.includes(window.location.host)) {
                if (el.href.startsWith('javascript:') || el.href.startsWith('#')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = '/proxy?url=' + encodeURIComponent(el.href);
              }
            }, true);

            // 2. 검색 폼 전송 가로채기
            document.addEventListener('submit', function(e) {
              var form = e.target;
              var action = form.action || window.location.href;
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                var formData = new FormData(form);
                var params = new URLSearchParams(formData);
                var fullUrl = action + (action.includes('?') ? '&' : '?') + params.toString();
                window.location.href = '/proxy?url=' + encodeURIComponent(fullUrl);
              }
            }, true);

            // 3. window.open 가로채기
            var originalOpen = window.open;
            window.open = function(url) {
              if (url) {
                var absUrl = new URL(url, window.location.href).href;
                window.location.href = '/proxy?url=' + encodeURIComponent(absUrl);
              }
              return null;
            };
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      // 기존 폼의 target 제거
      $('form').removeAttr('target');
      $('a').removeAttr('target').removeAttr('onclick');

      return res.send($.html());
    }
    
    res.send(response.data);
  } catch (error) {
    res.status(500).send('Proxy Error: ' + error.message);
  }
});

// [와일드카드] 모든 경로 이탈 방지
app.get('*', (req, res) => {
  if (['/proxy', '/search', '/'].includes(req.path)) return;
  
  const referer = req.headers.referer;
  let base = 'https://www.naver.com';
  
  if (referer && referer.includes('url=')) {
    try {
      const urlParams = new URL(referer).searchParams;
      base = new URL(urlParams.get('url')).origin;
    } catch(e) {}
  }
  res.redirect('/proxy?url=' + encodeURIComponent(base + req.originalUrl));
});

app.listen(port, () => { console.log('Server is running'); });

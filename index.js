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

  // [중요] 검색어만 오고 url이 없는 경우를 위한 자동 보정 로직
  if (!targetUrl) {
    if (req.query.query) { // 네이버 검색어 케이스
      targetUrl = 'https://search.naver.com/search.naver?query=' + encodeURIComponent(req.query.query);
    } else if (req.query.q) { // 구글/빙 검색어 케이스
      targetUrl = 'https://www.google.com/search?q=' + encodeURIComponent(req.query.q);
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다. (검색어 파라미터 누락)');

  try {
    // 나머지 파라미터들(sca_esv, ei 등)을 targetUrl에 병합
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url' && key !== 'query' && key !== 'q') {
        urlObj.searchParams.set(key, req.query[key]);
      }
    });
    targetUrl = urlObj.href;

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

      // [핵심] 폼(검색창) 처리 보강
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absoluteAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy');
          $(el).attr('method', 'GET');
          // 기존에 url hidden input이 없다면 생성하여 목적지 주입
          if ($(el).find('input[name="url"]').length === 0) {
            $(el).prepend(`<input type="hidden" name="url" value="${absoluteAction}">`);
          }
        } catch (e) {}
      });

      // 브라우저 측 가로채기 스크립트 (이전과 동일)
      const injectScript = `
        <script>
          document.addEventListener('submit', function(e) {
            var form = e.target;
            if (!form.action.includes(window.location.host)) {
              var urlInput = form.querySelector('input[name="url"]');
              if (!urlInput) {
                var action = form.action || window.location.href;
                var input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'url';
                input.value = action;
                form.prepend(input);
              }
            }
          }, true);
        </script>
      `;
      $('head').prepend(injectScript);

      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) {
    res.status(500).send('Proxy Error: ' + error.message);
  }
});

// 모든 경로 이탈 방지 와일드카드
app.get('*', (req, res) => {
  if (['/proxy', '/search', '/'].includes(req.path)) return;
  const originDomain = 'https://www.naver.com';
  res.redirect('/proxy?url=' + encodeURIComponent(originDomain + req.originalUrl));
});

app.listen(port, () => { console.log('Server is running'); });

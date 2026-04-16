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

  // [보정] URL이 없고 검색어만 있을 때 네이버 검색으로 간주
  if (!targetUrl && req.query.query) {
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const urlObj = new URL(targetUrl);
    // 모든 쿼리 파라미터를 타겟 URL에 합침
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.naver.com/'
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 모든 리소스 및 링크 경로 치환
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

      // 2. 폼 처리 (중복 방지)
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy').attr('method', 'GET');
          $(el).find('input[name="url"]').remove();
          $(el).prepend(`<input type="hidden" name="url" value="${absAction}">`);
        } catch (e) {}
      });

      // 3. 브라우저 측 강제 가로채기 (강력한 버전)
      const injectScript = `
        <script>
          (function() {
            // 클릭 가로채기
            document.addEventListener('click', function(e) {
              var a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
              }
            }, true);

            // 폼 전송 가로채기
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (!form.action.includes(window.location.host)) {
                e.preventDefault();
                var action = new URL(form.action, window.location.href).href;
                var fd = new FormData(form);
                var sp = new URLSearchParams(fd);
                window.location.href = '/proxy?url=' + encodeURIComponent(action + (action.includes('?') ? '&' : '?') + sp.toString());
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
    res.status(500).send('Proxy Error: ' + error.message);
  }
});

// [핵심] 와일드카드 경로 처리 - 이탈한 주소를 어떻게든 복원
app.get('*', (req, res) => {
  const path = req.path;
  if (path === '/proxy' || path === '/') return;

  const referer = req.headers.referer;
  
  // 1. 네이버 클릭 추적 경로면 네이버 도메인 결합
  if (path.includes('/p/crd/rd')) {
    const fullUrl = 'https://www.naver.com' + req.originalUrl;
    return res.redirect('/proxy?url=' + encodeURIComponent(fullUrl));
  }

  // 2. Referer 분석을 통한 경로 복원
  if (referer && referer.includes('url=')) {
    try {
      const refUrl = new URL(referer);
      const prevUrl = refUrl.searchParams.get('url');
      if (prevUrl) {
        const baseOrigin = new URL(prevUrl).origin;
        const recovered = baseOrigin + req.originalUrl;
        console.log("경로 복원 시도:", recovered);
        return res.redirect('/proxy?url=' + encodeURIComponent(recovered));
      }
    } catch (e) {}
  }

  // 3. 정보가 전혀 없을 때만 홈으로 (최후의 보루)
  res.redirect('/');
});

app.listen(port, () => { console.log('Server is running'); });

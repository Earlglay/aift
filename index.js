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

  // [보정] URL 없이 검색어만 들어온 경우 네이버 검색으로 강제 전환
  if (!targetUrl && req.query.query) {
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
  }

  if (!targetUrl) return res.redirect('/'); // URL이 없으면 400 에러 대신 홈으로 (사용자 경험)

  try {
    // 쿼리 파라미터 병합
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.naver.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    // 네이버가 302 리다이렉트를 보낸 경우(클릭 추적 완료 시) 가로채기
    if (response.status === 302 || response.status === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
            return res.redirect(`/proxy?url=${encodeURIComponent(new URL(redirectUrl, targetUrl).href)}`);
        }
    }

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 경로 치환 로직
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
      $('form').each((i, el) => {
        try {
          const action = $(el).attr('action') || '';
          const absAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy').attr('method', 'GET');
          $(el).find('input[name="url"]').remove();
          $(el).prepend(`<input type="hidden" name="url" value="${absAction}">`);
        } catch (e) {}
      });

      // 강력한 브라우저 가로채기 스크립트
      const injectScript = `
        <script>
          (function() {
            document.addEventListener('click', function(e) {
              var a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
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

// [와일드카드 최후의 수단] 모든 "알 수 없는 경로"를 네이버로 보내기
app.get('*', (req, res) => {
  const path = req.path;
  // 예약된 경로 및 정적 파일 제외
  if (['/proxy', '/'].includes(path) || path.includes('.')) return res.redirect('/');

  // 네이버 클릭 추적(/p/crd/rd) 또는 네이버 전용 경로들 가로채기
  const originDomain = 'https://www.naver.com';
  const recoveredUrl = originDomain + req.originalUrl;
  
  console.log("알 수 없는 경로 발견, 네이버로 강제 복원:", recoveredUrl);
  res.redirect('/proxy?url=' + encodeURIComponent(recoveredUrl));
});

app.listen(port, () => { console.log('Server is running'); });

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

  // [수정 1] URL이 없는데 검색어만 들어온 경우 긴급 보정
  if (!targetUrl) {
    const query = req.query.query || req.query.q;
    if (query) {
      targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`;
    } else {
      return res.status(400).send('URL이 필요합니다.');
    }
  }

  try {
    // [수정 2] 파라미터 병합 로직 정교화
    // targetUrl 내부에 이미 query가 포함되어 있을 수 있으므로 중복을 방지하며 합칩니다.
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') {
        // 기존 targetUrl에 있는 값보다 현재 req.query에 들어온 새 값이 우선순위
        urlObj.searchParams.set(key, req.query[key]);
      }
    });
    targetUrl = urlObj.href;

    console.log("최종 목적지 URL:", targetUrl); // 로그로 확인 가능

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.naver.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 15000,
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

      // [수정 3] 검색 폼 강제 교정
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy'); // 우리 서버로 전송
          $(el).attr('method', 'GET');
          
          // url 필드가 이미 있다면 제거 후 새로 생성 (중복 방지)
          $(el).find('input[name="url"]').remove();
          $(el).prepend(`<input type="hidden" name="url" value="${absAction}">`);
        } catch (e) {}
      });

      // 가로채기 스크립트 주입
      const injectScript = `
        <script>
          // 폼 전송 시 url 파라미터가 반드시 포함되도록 보장
          document.addEventListener('submit', function(e) {
            var form = e.target;
            if (form.action.includes(window.location.host)) {
               // url input이 없으면 생성
               if (!form.querySelector('input[name="url"]')) {
                 var input = document.createElement('input');
                 input.type = 'hidden'; input.name = 'url';
                 input.value = window.location.href.split('url=')[1] ? decodeURIComponent(window.location.href.split('url=')[1]) : window.location.href;
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

// [수정 4] 와일드카드 리다이렉트 시 쿼리 스트링 유지
app.get('*', (req, res) => {
  if (['/proxy', '/search', '/'].includes(req.path)) return;
  const originDomain = 'https://www.naver.com';
  // 검색어(?query=...)가 포함된 originalUrl을 그대로 인코딩해서 전달
  res.redirect('/proxy?url=' + encodeURIComponent(originDomain + req.originalUrl));
});

app.listen(port, () => { console.log('Server is running'); });

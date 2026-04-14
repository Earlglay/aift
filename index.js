const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// [1] DB 연결 설정
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// [2] 핵심 프록시 엔진
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 파라미터 병합 (검색어 등 유지)
  if (targetUrl) {
    try {
      const urlObj = new URL(targetUrl);
      Object.keys(req.query).forEach(key => {
        if (key !== 'url') {
          urlObj.searchParams.set(key, req.query[key]);
        }
      });
      targetUrl = urlObj.href;
    } catch (e) {
      console.error("URL 생성 실패:", e);
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 처리
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

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

      rewrite('img', 'src');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('a', 'href');

      // 폼 처리
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absoluteAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy');
          $(el).attr('method', 'GET');
          if ($(el).find('input[name="url"]').length === 0) {
            $(el).prepend('<input type="hidden" name="url" value="' + absoluteAction + '">');
          }
        } catch (e) {}
      });

      if (pool) {
        pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      }

      return res.send($.html());
    }

    // CSS 처리
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\(['"]?([^'")]*)['"]?\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          const absolute = new URL(p1, targetUrl).href;
          return 'url("/proxy?url=' + encodeURIComponent(absolute) + '")';
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    res.send(response.data);

  } catch (error) {
    res.status(500).send('Proxy Error: ' + error.message);
  }
});

// [3] 경로 이탈 및 추적 경로 자동 복원 (와일드카드)
app.get('*', (req, res) => {
  const path = req.path;
  if (path === '/proxy' || path === '/search' || path === '/') return;

  // (1) 네이버 전용 추적 경로 가로채기
  if (path.includes('/p/crd/rd')) {
    const fullUrl = 'https://www.naver.com' + req.originalUrl;
    return res.redirect('/proxy?url=' + encodeURIComponent(fullUrl));
  }

  // (2) Referer를 활용한 상대 경로 도메인 추론
  const referer = req.headers.referer;
  if (referer && referer.includes('/proxy?url=')) {
    try {
      const refUrl = new URL(referer);
      const originalReferer = refUrl.searchParams.get('url');
      if (originalReferer) {
        const lastBase = new URL(originalReferer).origin;
        const recoveredUrl = lastBase + req.originalUrl;
        console.log('경로 복원 성공:', recoveredUrl);
        return res.redirect('/proxy?url=' + encodeURIComponent(recoveredUrl));
      }
    } catch (e) {}
  }

  // (3) 근거가 없으면 홈으로 이동 (무한 루프 방지)
  res.redirect('/');
});

app.listen(port, () => { console.log('Server running on ' + port); });

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// [1] DB 연결 설정 (Neon DB)
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

// [2] 핵심 프록시 엔진: /proxy 경로 처리
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // Bing/Google 검색 시 발생하는 /search 경로 이탈 방지 로직
  if (!targetUrl && req.query.q) {
    const engine = req.headers.referer && req.headers.referer.includes('google') ? 'google.com' : 'bing.com';
    targetUrl = `https://www.${engine}/search?q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 처리 (경로 치환 및 폼 가로채기)
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const absolute = new URL(val, targetUrl).href;
              $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
            } catch (e) {}
          }
        });
      };

      rewrite('img', 'src');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('source', 'src');

      // 링크 클릭 시 프록시 유지
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
          try {
            const absoluteUrl = new URL(href, targetUrl).href;
            $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
          } catch (e) {}
        }
      });

      // 폼(검색창) 전송 경로를 무조건 /proxy로 고정
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absoluteAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy'); 
          $(el).attr('method', 'GET');
          if ($(el).find('input[name="url"]').length === 0) {
            $(el).prepend(`<input type="hidden" name="url" value="${absoluteAction}">`);
          }
        } catch (e) {}
      });

      if (pool) {
        pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      }

      return res.send($.html());
    }

    // CSS 내부 경로(배경 이미지 등) 처리
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\(['"]?([^'")]*)['"]?\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          const absolute = new URL(p1, targetUrl).href;
          return `url("/proxy?url=${encodeURIComponent(absolute)}")`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    res.send(response.data);

  } catch (error) {
    res.status(500).send(`접속 오류: ${error.message}`);
  }
});

// [3] 예외 처리: 사이트가 강제로 /search로 보낼 경우를 대비한 별도 경로 설정
app.get('/search', (req, res) => {
  // 사용자가 우리 서버의 /search로 튕겨져 들어오면, 검색어(q)를 낚아채서 /proxy로 리다이렉트
  const query = req.query.q;
  if (query) {
    res.redirect(`/proxy?q=${encodeURIComponent(query)}`);
  } else {
    res.redirect('/');
  }
});

app.listen(port, () => { console.log(`Proxy server running on port ${port}`); });

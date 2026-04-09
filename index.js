const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// DB 연결 설정
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

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    // 접속한 기기의 정보를 그대로 전달하여 레이아웃 최적화
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer', // 이미지/폰트 깨짐 방지
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 처리: 상대 경로를 절대 경로(프록시 주소)로 치환
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

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
      rewrite('a', 'href');

      // 폼(검색 등) 처리
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

    // CSS 처리: url() 경로 치환
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

    // 그 외 파일(이미지 등)은 그대로 전송
    res.send(response.data);

  } catch (error) {
    res.status(500).send(`접속 오류: ${error.message}`);
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

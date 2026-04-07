const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// DB 연결 (Render 환경 변수 DATABASE_URL 사용)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // [1] HTML인 경우: 태그들의 경로를 우리 프록시 주소로 치환
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
      rewrite('img', 'srcset');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('source', 'src');
      rewrite('source', 'srcset');
      rewrite('video', 'src');
      rewrite('audio', 'src');

      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
          try {
            const absoluteUrl = new URL(href, targetUrl).href;
            $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
          } catch (e) {}
        }
      });

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

      // 방문 기록 저장 (오류나도 무시)
      pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

      return res.send($.html());
    }

    // [2] CSS인 경우: url() 안의 경로들을 프록시로 치환 (배경 이미지 해결)
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

    // [3] 그 외(이미지, 폰트 등): 원본 바이너리 그대로 전송
    res.send(response.data);

  } catch (error) {
    res.status(500).send(`접속 오류: ${error.message}`);
  }
});

app.listen(port, () => { console.log(`Proxy server running on port ${port}`); });

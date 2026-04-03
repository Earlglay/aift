const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 구글 검색 파라미터 처리
  if (req.query.q && targetUrl && targetUrl.includes('google.com')) {
    targetUrl = `https://www.google.com/search?q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        // 범용적인 최신 데스크톱 브라우저 헤더로 복구 (차단 확률 낮춤)
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.google.com/'
      },
      responseType: 'text',
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // 모든 리소스를 우리 서버를 거치도록 수정
    const rewrite = (tag, attr) => {
      $(tag).each((i, el) => {
        const val = $(el).attr(attr);
        if (val && !val.startsWith('data:')) {
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

    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absolute = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absolute)}`);
        } catch (e) {}
      }
    });

    // DB 저장
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (error) {
    // 이미지/CSS 등 정적 리소스 요청일 경우 직접 전달
    try {
      const resData = await axios.get(targetUrl, { responseType: 'arraybuffer' });
      res.set('Content-Type', resData.headers['content-type']);
      return res.send(resData.data);
    } catch (e) {
      console.error("Proxy Error:", error.message);
      res.status(500).send(`접속 오류: ${error.message}`);
    }
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

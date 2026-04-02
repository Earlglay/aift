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

// 핵심 프록시 엔진
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      responseType: 'text',
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const baseUrl = new URL(targetUrl);

    // 1. 모든 리소스 주소를 우리 프록시 주소로 강제 치환
    const rewrite = (tag, attr) => {
      $(tag).each((i, el) => {
        const val = $(el).attr(attr);
        if (val && !val.startsWith('data:')) {
          try {
            const absolute = new URL(val, targetUrl).href;
            // 리소스도 우리 프록시(/proxy?url=...)를 거치게 만듦
            $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
          } catch (e) {}
        }
      });
    };

    rewrite('img', 'src');
    rewrite('link', 'href');
    rewrite('script', 'src');
    rewrite('source', 'src');

    // 2. 하이퍼링크 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absolute = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absolute)}`);
        } catch (e) {}
      }
    });

    // 3. DB 기록 (비동기)
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    // 원본 사이트의 Content-Type을 최대한 유지하여 전송
    res.set('Content-Type', response.headers['content-type']);
    res.send($.html());

  } catch (error) {
    // 만약 HTML이 아닌 이미지/CSS 파일 요청이라면 데이터를 그대로 전달
    try {
      const resData = await axios.get(targetUrl, { responseType: 'arraybuffer' });
      res.set('Content-Type', resData.headers['content-type']);
      return res.send(resData.data);
    } catch (e) {
      res.status(500).send(`오류: ${error.message}`);
    }
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

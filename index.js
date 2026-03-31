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
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000
    });

    const $ = cheerio.load(response.data);

    // 1. 이미지 경로 수정
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && !src.startsWith('http')) {
        try { $(el).attr('src', new URL(src, targetUrl).href); } catch (e) {}
      }
    });

    // 2. 링크(a) 경로 수정
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // 3. 스타일시트 경로 수정
    $('link[rel="stylesheet"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('http')) {
        try { $(el).attr('href', new URL(href, targetUrl).href); } catch (e) {}
      }
    });

    // 4. DB에 방문 기록 저장 (비동기로 실행하여 응답 속도 유지)
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(err => console.error('DB 저장 실패:', err));

    res.send($.html());
  } catch (error) {
    res.status(500).send('접속 오류: ' + error.message);
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

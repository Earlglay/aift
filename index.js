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
  let targetUrl = req.query.url;

  // [수정] 구글 검색(q) 파라미터가 들어올 경우 처리
  if (req.query.q) {
    if (targetUrl && targetUrl.includes('google.com')) {
        // 구글 검색 주소 형식을 강제로 맞춤
        targetUrl = `https://www.google.com/search?q=${encodeURIComponent(req.query.q)}`;
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // 1. 이미지/리소스 경로 수정
    $('img, link, script').each((i, el) => {
      const attr = $(el).is('img') ? 'src' : ($(el).is('link') ? 'href' : 'src');
      const val = $(el).attr(attr);
      if (val && !val.startsWith('http') && !val.startsWith('data:')) {
        try { $(el).attr(attr, new URL(val, targetUrl).href); } catch (e) {}
      }
    });

    // 2. 링크(a) 클릭 시 프록시 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // 3. [핵심 수정] 폼(검색창) 처리
    $('form').each((i, el) => {
      // 구글 같은 경우 action이 '/search'로 되어 있으면 절대 경로로 변경
      const action = $(el).attr('action') || '';
      try {
        const absoluteAction = new URL(action, targetUrl).href;
        $(el).attr('method', 'GET'); // 강제로 GET 방식으로 통일
        $(el).attr('action', '/proxy'); 
        // 목적지 주소를 숨겨진 input으로 전달
        if ($(el).find('input[name="url"]').length === 0) {
            $(el).append(`<input type="hidden" name="url" value="${absoluteAction}">`);
        }
      } catch (e) {}
    });

    // 4. DB 저장
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.send($.html());

  } catch (error) {
    res.status(500).send(`접속 오류: ${error.message}`);
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

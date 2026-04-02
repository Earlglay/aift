const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// 1. Neon DB 연결 설정 (Render 환경변수 DATABASE_URL 참조)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 핵심 프록시 엔진
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 구글 검색 등 폼 전송 시 'q' 파라미터가 오면 처리하는 로직
  if (req.query.q && targetUrl) {
    targetUrl += `&q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    // [A] 이미지 및 리소스 경로 수정
    $('img, link, script').each((i, el) => {
      const attr = $(el).is('img') ? 'src' : ($(el).is('link') ? 'href' : 'src');
      const val = $(el).attr(attr);
      if (val && !val.startsWith('http') && !val.startsWith('data:')) {
        try { $(el).attr(attr, new URL(val, targetUrl).href); } catch (e) {}
      }
    });

    // [B] 하이퍼링크 클릭 시 프록시 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // [C] 폼(검색창) 전송 경로 수정 (구글 검색 등 대응)
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      try {
        const absoluteAction = new URL(action, targetUrl).href;
        $(el).attr('action', '/proxy'); // 우리 서버로 먼저 보내게 함
        $(el).append(`<input type="hidden" name="url" value="${absoluteAction}">`);
      } catch (e) {}
    });

    // [D] DB에 방문 기록 저장 (비동기)
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl])
        .catch(err => console.error('DB 저장 실패:', err));

    res.send($.html());

  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).send(`접속 오류: 해당 사이트에서 접속을 차단했거나 주소가 잘못되었습니다. (${error.message})`);
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Neon DB 연결
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

  // 구글 검색어 처리
  if (req.query.q && targetUrl && targetUrl.includes('google.com')) {
    targetUrl = `https://www.google.com/search?q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    // [보강] 실제 브라우저와 거의 흡사한 헤더 설정 (레딧 차단 회피용)
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.google.com/',
        'Cache-Control': 'max-age=0'
      },
      timeout: 15000 // 레딧은 무거우므로 응답 대기 시간을 15초로 연장
    });

    const $ = cheerio.load(response.data);

    // 1. 이미지, 스타일시트, 스크립트 경로 수정
    $('img, link, script').each((i, el) => {
      const attr = $(el).is('img') ? 'src' : ($(el).is('link') ? 'href' : 'src');
      const val = $(el).attr(attr);
      if (val && !val.startsWith('http') && !val.startsWith('data:')) {
        try { $(el).attr(attr, new URL(val, targetUrl).href); } catch (e) {}
      }
    });

    // 2. 모든 링크(a) 클릭 시 프록시 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // 3. 폼(검색창 등) 전송 경로 수정
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      try {
        const absoluteAction = new URL(action, targetUrl).href;
        $(el).attr('method', 'GET');
        $(el).attr('action', '/proxy');
        if ($(el).find('input[name="url"]').length === 0) {
          $(el).append(`<input type="hidden" name="url" value="${absoluteAction}">`);
        }
      } catch (e) {}
    });

    // 4. DB에 방문 기록 저장 (오류 나도 무시하고 진행)
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    // 결과 전송
    res.send($.html());

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).send(`
      <div style="padding:20px; font-family:sans-serif;">
        <h2>접속 실패 (레딧 등 보안 사이트 알림)</h2>
        <p>에러 내용: ${error.message}</p>
        <hr>
        <p><b>팁:</b> 레딧의 경우 <b>https://old.reddit.com</b>으로 접속하면 더 잘 작동할 수 있습니다.</p>
        <button onclick="history.back()" style="padding:10px 20px; cursor:pointer;">뒤로가기</button>
      </div>
    `);
  }
});

app.listen(port, () => { console.log(`Proxy server running on port ${port}`); });

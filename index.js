const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// 1. Neon DB 연결 설정
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

  // 구글 검색어 처리
  if (req.query.q && targetUrl && targetUrl.includes('google.com')) {
    targetUrl = `https://www.google.com/search?q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    // [보강] 나무위키/레딧 차단을 피하기 위한 정교한 헤더 설정
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Referer': 'https://www.google.com/',
        'Cache-Control': 'max-age=0'
      },
      timeout: 20000 // 보안 검사를 위해 20초 대기
    });

    const $ = cheerio.load(response.data);

    // [A] 리소스(이미지, 스타일, 스크립트) 경로 수정
    $('img, link, script').each((i, el) => {
      const attr = $(el).is('img') ? 'src' : ($(el).is('link') ? 'href' : 'src');
      const val = $(el).attr(attr);
      if (val && !val.startsWith('http') && !val.startsWith('data:')) {
        try { $(el).attr(attr, new URL(val, targetUrl).href); } catch (e) {}
      }
    });

    // [B] 모든 링크(a) 클릭 시 프록시 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // [C] 폼(검색창) 전송 경로 수정
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

    // [D] DB에 방문 기록 저장
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.send($.html());

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).send(`
      <div style="padding:20px; font-family:sans-serif; line-height:1.6;">
        <h2 style="color:#e74c3c;">⚠️ 접속 제한 알림</h2>
        <p><b>에러 메시지:</b> ${error.message}</p>
        <hr>
        <p>나무위키나 대형 사이트는 보안 서비스(Cloudflare 등)가 서버의 접속을 차단할 수 있습니다.</p>
        <ul style="color:#555;">
          <li><b>방법 1:</b> <b>https://namu.mirror.wiki</b> 같은 미러 사이트를 입력해 보세요.</li>
          <li><b>방법 2:</b> 구버전 사이트(예: old.reddit.com)를 이용해 보세요.</li>
          <li><b>방법 3:</b> 잠시 후 다시 시도해 보세요.</li>
        </ul>
        <button onclick="history.back()" style="padding:10px 20px; cursor:pointer; background:#3498db; color:white; border:none; border-radius:5px;">뒤로가기</button>
      </div>
    `);
  }
});

app.listen(port, () => { console.log(`Proxy server running on port ${port}`); });

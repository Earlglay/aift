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
  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        // 모바일 브라우저처럼 보이게 하여 모바일용 레이아웃 유도
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // [핵심] 모든 리소스(이미지, CSS, JS)의 상대 경로를 절대 경로로 강제 변환
    const tags = { 'img': 'src', 'link': 'href', 'script': 'src', 'source': 'src', 'video': 'src' };
    
    Object.entries(tags).forEach(([tag, attr]) => {
      $(tag).each((i, el) => {
        const val = $(el).attr(attr);
        if (val && !val.startsWith('http') && !val.startsWith('data:')) {
          try {
            const absolute = new URL(val, targetUrl).href;
            $(el).attr(attr, absolute);
          } catch (e) {}
        }
      });
    });

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

    // 폼 전송 유지
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      try {
        const absoluteAction = new URL(action, targetUrl).href;
        $(el).attr('method', 'GET');
        $(el).attr('action', '/proxy');
        $(el).append(`<input type="hidden" name="url" value="${absoluteAction}">`);
      } catch (e) {}
    });

    // 방문 기록 저장
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.send($.html());
  } catch (error) {
    res.status(500).send(`오류 발생: ${error.message}`);
  }
});

app.listen(port, () => { console.log(`Running on ${port}`); });  

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
    // [수정] 특정 기기 고정이 아닌, 현재 접속한 브라우저의 User-Agent를 그대로 전달
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'text',
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // 1. 모든 리소스를 우리 서버를 거치도록 수정 (상대경로 -> 절대경로)
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

    // 2. 하이퍼링크 및 폼 처리
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

    // 3. 기록 저장
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (error) {
    // 이미지/CSS 등 파일은 원본 그대로 전달
    try {
      const resData = await axios.get(targetUrl, { responseType: 'arraybuffer' });
      res.set('Content-Type', resData.headers['content-type']);
      return res.send(resData.data);
    } catch (e) {
      res.status(500).send(`접속 오류: ${error.message}`);
    }
  }
});

app.listen(port, () => { console.log(`Server running on ${port}`); });

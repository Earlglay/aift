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

  // [수정] 폼 전송 시 검색어(q)가 파라미터로 들어올 경우 처리
  if (req.query.q && targetUrl) {
    const urlObj = new URL(targetUrl);
    urlObj.searchParams.set('q', req.query.q);
    targetUrl = urlObj.href;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // 1. 리소스 경로 수정 (이미지, 스타일, 스크립트)
    const rewriteAttr = (tag, attr) => {
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
    rewriteAttr('img', 'src');
    rewriteAttr('link', 'href');
    rewriteAttr('script', 'src');

    // 2. 링크 클릭 시 프록시 유지
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        try {
          const absoluteUrl = new URL(href, targetUrl).href;
          $(el).attr('href', `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {}
      }
    });

    // 3. [핵심] 모든 폼(Form)의 전송 대상을 우리 서버의 /proxy로 강제 변경
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      try {
        const absoluteAction = new URL(action, targetUrl).href;
        $(el).attr('action', '/proxy'); // 무조건 우리 서버의 /proxy로 보냄
        $(el).attr('method', 'GET');    // 처리가 쉬운 GET 방식으로 통일
        
        // 진짜 목적지 URL을 숨겨진 input으로 삽입
        if ($(el).find('input[name="url"]').length === 0) {
          $(el).prepend(`<input type="hidden" name="url" value="${absoluteAction}">`);
        }
      } catch (e) {}
    });

    // 4. DB 기록
    pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (error) {
    // HTML이 아닌 리소스(이미지 등) 직접 처리
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

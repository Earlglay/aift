const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// [1] DB 연결 설정 (Render 환경 변수 사용)
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// [2] 핵심 프록시 엔진
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // [검색 엔진 예외 처리] url 없이 검색어(q, query)만 들어온 경우 대응
  if (!targetUrl) {
    if (req.query.query) { // 네이버 방식
      targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
    } else if (req.query.q) { // 구글/빙 방식
      targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(req.query.q)}`;
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    // 현재 접속한 기기(태블릿/모바일)의 User-Agent를 그대로 전달하여 레이아웃 최적화
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer', // 모든 데이터를 바이너리로 받아 깨짐 방지
      timeout: 15000,
      validateStatus: false
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // [HTML 처리]
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // 리소스 경로 치환 (이미지, 스크립트 등)
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const absolute = new URL(val, targetUrl).href;
              $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
            } catch (e) {}
          }
        });
      };

      rewrite('img', 'src');
      rewrite('img', 'srcset');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('source', 'src');

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

      // 폼(검색창) 가로채기 보강
      $('form').each((i, el) => {
        const action = $(el).attr('action') || '';
        try {
          const absoluteAction = new URL(action, targetUrl).href;
          $(el).attr('action', '/proxy'); 
          $(el).attr('method', 'GET');
          
          // 목적지 URL을 숨겨진 input으로 삽입
          if ($(el).find('input[name="url"]').length === 0) {
            $(el).prepend(`<input type="hidden" name="url" value="${absoluteAction}">`);
          }
        } catch (e) {}
      });

      if (pool) {
        pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      }

      return res.send($.html());
    }

    // [CSS 처리] 배경 이미지 경로 치환
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\(['"]?([^'")]*)['"]?\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          const absolute = new URL(p1, targetUrl).href;
          return `url("/proxy?url=${encodeURIComponent(absolute)}")`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    // 그 외 리소스(이미지 등)는 그대로 전송
    res.send(response.data);

  } catch (error) {
    res.status(500).send(`접속 오류: ${error.message}`);
  }
});

// [3] 경로 이탈 대응 (네이버/빙/구글의 /search 요청 수신)
app.get('/search', (req, res) => {
  const query = req.query.query || req.query.q; // query(네이버) 또는 q(구글/빙) 확인
  if (query) {
    // 검색어가 있다면 적절한 파라미터명과 함께 /proxy로 보냄
    const paramName = req.query.query ? 'query' : 'q';
    res.redirect(`/proxy?${paramName}=${encodeURIComponent(query)}`);
  } else {
    res.redirect('/');
  }
});

app.listen(port, () => { console.log(`Proxy server running on port ${port}`); });

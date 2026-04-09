const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// [1] DB 연결 설정
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

  // 검색어 대응 로직
  if (!targetUrl) {
    if (req.query.query) {
      targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
    } else if (req.query.q) {
      targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(req.query.q)}`;
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 처리
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

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
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('a', 'href');

      // 자바스크립트 주입 (클릭/이동 가로채기)
      const injectScript = `
        <script>
          (function() {
            document.addEventListener('click', function(e) {
              var a = e.target.closest('a');
              if (a && a.href && !a.href.startsWith(window.location.origin + '/proxy')) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
              }
            }, true);

            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form.action && !form.action.startsWith(window.location.origin + '/proxy')) {
                e.preventDefault();
                var action = new URL(form.action, window.location.href).href;
                var formData = new URLSearchParams(new FormData(form)).toString();
                window.location.href = '/proxy?url=' + encodeURIComponent(action + (action.includes('?') ? '&' : '?') + formData);
              }
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      $('meta[http-equiv="Content-Security-Policy"]').remove();

      if (pool) {
        pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      }

      return res.send($.html());
    }

    // CSS 처리
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\(['"]?([^'")]*)['"]?\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          const abs = new URL(p1, targetUrl).href;
          return `url("/proxy?url=${encodeURIComponent(abs)}")`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    res.send(response.data);

  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.get('/search', (req, res) => {
  const q = req.query.query || req.query.q;
  if (q) res.redirect(`/proxy?${req.query.query ? 'query' : 'q'}=${encodeURIComponent(q)}`);
  else res.redirect('/');
});

app.listen(port, () => { console.log(`Server is running on port ${port}`); });

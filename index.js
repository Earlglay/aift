const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 검색 파라미터 대응 (네이버 query, 구글/빙 q)
  if (!targetUrl) {
    if (req.query.query) targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
    else if (req.query.q) targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(req.query.q)}`;
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

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

    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // 1. 기본 리소스 치환 (이미지, CSS, JS) - 디자인 유지의 핵심
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

      // 2. [강력한 해결책] 자바스크립트 주입 - 클릭 및 이동 해결
      // 페이지 내의 모든 클릭을 감시하여 강제로 프록시 주소를 붙입니다.
      const injectScript = `
        <script>
          (function() {
            // 모든 클릭 가로채기
            document.addEventListener('click', function(e) {
              var a = e.target.closest('a');
              if (a && a.href && !a.href.startsWith(window.location.origin + '/proxy')) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                var target = new URL(a.href, window.location.href).href;
                window.location.href = '/proxy?url=' + encodeURIComponent(target);
              }
            }, true);

            // 모든 폼 전송 가로채기 (검색 등)
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form.action && !form.action.startsWith(window.location.origin + '/proxy')) {
                e.preventDefault();
                var action = new URL(form.action, window.location.href).href;
                var formData = new URLSearchParams(new FormData(form)).toString();
                var finalUrl = action + (action.includes('?') ? '&' : '?') + formData;
                window.location.href = '/proxy?url=' + encodeURIComponent(finalUrl);
              }
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      // 보안 정책 제거
      $('meta[http-equiv="Content-Security-Policy"]').remove();

      if (pool) pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      return res.send($.html());
    }

    // CSS 내 배경 이미지 처리
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\\(['\"]?([^'\")]*)['\"]?\\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          return \`url("/proxy?url=\${encodeURIComponent(new URL(p1, targetUrl).href)}")\`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    res.send(response.data);
  } catch (error) {
    res.status(500).send(\`접속 오류: \${error.message}\`);
  }
});

// 경로 이탈(/search) 대응
app.get('/search', (req, res) => {
  const query = req.query.query || req.query.q;
  if (query) {
    const param = req.query.query ? 'query' : 'q';
    res.redirect(\`/proxy?\${param}=\${encodeURIComponent(query)}\`);
  } else { res.redirect('/'); }
});

app.listen(port, () => { console.log(\`Running on \${port}\`); });

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

  if (targetUrl) {
    try {
      const urlObj = new URL(targetUrl);
      Object.keys(req.query).forEach(key => {
        if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
      });
      targetUrl = urlObj.href;
    } catch (e) {}
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

    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      
      // 보안 정책(CSP) 해제 - 브라우저가 외부 스크립트 차단하는 것 방지
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/gi, '');

      const $ = cheerio.load(html);

      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const absolute = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(absolute));
            } catch (e) {}
          }
        });
      };

      rewrite('img', 'src');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('a', 'href');

      // [핵심] 초강력 자바스크립트 가로채기 주입
      const injectScript = `
        <script>
          // 모든 클릭을 가로채서 절대 놓치지 않음
          window.onclick = function(e) {
            var el = e.target;
            while (el && el.tagName !== 'A') el = el.parentNode;
            if (el && el.href) {
              if (el.href.indexOf(window.location.host) === -1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = '/proxy?url=' + encodeURIComponent(el.href);
                return false;
              }
            }
          };
          // 원본 스크립트가 주소를 바꾸지 못하게 방어
          var originalLocation = window.location.href;
          window.onbeforeunload = function() {
            // 원치 않는 리다이렉트 감지 시 로직 추가 가능
          };
        </script>
      `;
      
      $('head').prepend(injectScript);
      $('a').removeAttr('target').removeAttr('rel');
      
      // 인라인 스크립트(onclick 등) 내의 주소도 억지로 바꿈
      $('*[onclick]').each((i, el) => {
        $(el).removeAttr('onclick'); 
      });

      return res.send($.html());
    }

    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\(['"]?([^'")]*)['"]?\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          return 'url("/proxy?url=' + encodeURIComponent(new URL(p1, targetUrl).href) + '")';
        } catch (e) { return match; }
      });
      return res.send(css);
    }
    res.send(response.data);
  } catch (error) {
    res.status(500).send('Proxy Error: ' + error.message);
  }
});

app.get('*', (req, res) => {
  const path = req.path;
  if (path === '/proxy' || path === '/search' || path === '/') return;

  const referer = req.headers.referer;
  const originDomain = 'https://www.naver.com'; // 기본값을 네이버로 설정

  if (referer && referer.includes('/proxy?url=')) {
    try {
      const refUrl = new URL(referer);
      const originalReferer = refUrl.searchParams.get('url');
      if (originalReferer) {
        const lastBase = new URL(originalReferer).origin;
        return res.redirect('/proxy?url=' + encodeURIComponent(lastBase + req.originalUrl));
      }
    } catch (e) {}
  }
  
  // 정보를 알 수 없을 때는 네이버라고 가정하고 보냄 (홈으로 튕김 방지)
  res.redirect('/proxy?url=' + encodeURIComponent(originDomain + req.originalUrl));
});

app.listen(port, () => { console.log('Server is running'); });

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
// Render는 자동으로 포트를 할당하므로 반드시 process.env.PORT를 써야 합니다.
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 프록시 핵심 로직
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 검색어만 들어온 경우 보정
  if (!targetUrl && (req.query.query || req.query.q)) {
    const q = req.query.query || req.query.q;
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
  }

  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.naver.com/'
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const htmlContent = response.data.toString('utf-8');
      const $ = cheerio.load(htmlContent);

      // 경로 치환 (이미지, 스타일, 스크립트 등)
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const abs = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(abs));
            } catch (e) {}
          }
        });
      };
      rewrite('img', 'src'); rewrite('link', 'href'); rewrite('script', 'src'); rewrite('a', 'href');

      // 튕김 방지 스크립트 주입
      const injectScript = `
        <script>
          (function() {
            const wrap = (u) => {
              if(!u || u.startsWith('javascript:') || u.startsWith('#')) return u;
              const abs = new URL(u, window.location.href).href;
              return window.location.origin + '/proxy?url=' + encodeURIComponent(abs);
            };
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                window.location.href = wrap(a.href);
              }
            }, true);
            window.addEventListener('submit', function(e) {
              const form = e.target;
              if (!form.action.includes(window.location.host)) {
                e.preventDefault();
                const action = new URL(form.action || window.location.href, window.location.href).href;
                const sp = new URLSearchParams(new FormData(form));
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.redirect('/');
  }
});

// 마지막 와일드카드 (가장 단순화)
app.get('*', (req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

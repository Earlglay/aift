const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // [긴급 복구] URL이 없는데 검색어만 들어온 경우 네이버로 연결
  if (!targetUrl && (req.query.query || req.query.q)) {
    const q = req.query.query || req.query.q;
    targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`;
  }

  if (!targetUrl) return res.redirect('/');

  try {
    // 파라미터 병합
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
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 모든 리소스 경로 치환
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

      // 2. 브라우저 측 가로채기 (가장 안정적인 방식)
      const injectScript = `
        <script>
          (function() {
            // 모든 클릭 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
                e.preventDefault();
                window.location.href = '/proxy?url=' + encodeURIComponent(a.href);
              }
            }, true);

            // [수정] 폼 전송 시 주소창에 직접 목적지를 꽂아넣음
            window.addEventListener('submit', function(e) {
              const form = e.target;
              // 이미 우리 프록시로 가고 있다면 통과
              if (form.action.includes(window.location.host + '/proxy')) return;
              
              e.preventDefault();
              const action = new URL(form.action || window.location.href, window.location.href).href;
              const params = new URLSearchParams(new FormData(form));
              const finalUrl = action.split('?')[0] + '?' + params.toString();
              
              window.location.href = window.location.origin + '/proxy?url=' + encodeURIComponent(finalUrl);
            }, true);
            
            // 네이버의 History 조작(튕김 현상) 방지
            const wrap = (u) => u.includes(window.location.host) ? u : (window.location.origin + '/proxy?url=' + encodeURIComponent(new URL(u, window.location.href).href));
            const orgPush = history.pushState;
            history.pushState = function(s, t, u) {
              if (u) return window.location.href = wrap(u);
              return orgPush.apply(this, arguments);
            };
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      // 3. 폼 설정 초기화 (브라우저 기본 동작 사용)
      $('form').removeAttr('onsubmit'); 

      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) {
    res.redirect('/');
  }
});

// [와일드카드] 길 잃은 요청 복구
app.get('*', (req, res) => {
  const path = req.path;
  if (['/proxy', '/'].includes(path) || path.includes('.')) return res.redirect('/');
  
  const referer = req.headers.referer;
  let domain = 'https://www.naver.com';
  if (referer && referer.includes('url=')) {
    try {
      const prev = new URL(referer).searchParams.get('url');
      if (prev) domain = new URL(prev).origin;
    } catch (e) {}
  }
  res.redirect('/proxy?url=' + encodeURIComponent(domain + req.originalUrl));
});

app.listen(port, () => { console.log('Proxy Fixed'); });

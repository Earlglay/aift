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

  // 검색어만 들어온 경우 네이버로 자동 연결 (검색 기능 유지)
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
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 모든 리소스 주소 치환 (이미지, 스크립트, 링크)
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

      // 2. 브라우저 측 초강력 보호 스크립트 주입
      const injectScript = `
        <script>
          (function() {
            const currentOrigin = window.location.origin;
            const wrapUrl = (u) => {
              if (!u || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(currentOrigin)) return abs;
                return currentOrigin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // [추가] 네이버의 강제 리다이렉트 시도 차단
            window.onbeforeunload = function() {
              // 페이지가 떠나기 직전 감지 (필요 시 로직 확장 가능)
            };

            // 모든 클릭 가로채기 (캡처링 단계)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href) {
                const target = a.href;
                if (!target.includes(currentOrigin)) {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  window.location.href = wrapUrl(target);
                }
              }
            }, true);

            // 폼 전송 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = wrapUrl(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // [핵심] History API 및 Location 조작 감시
            const orgPush = history.pushState;
            history.pushState = function(state, title, url) {
              if (url && !url.includes(currentOrigin)) {
                return window.location.href = wrapUrl(url);
              }
              return orgPush.apply(this, arguments);
            };

            const orgReplace = history.replaceState;
            history.replaceState = function(state, title, url) {
              if (url && !url.includes(currentOrigin)) {
                return window.location.href = wrapUrl(url);
              }
              return orgReplace.apply(this, arguments);
            };
          })();
        </script>
      `;
      $('head').prepend(injectScript);

      return res.send($.html());
    }
    res.send(response.data);
  } catch (error) {
    res.redirect('/');
  }
});

// 3. [최후의 보루] 와일드카드 경로 이탈 복구
app.get('*', (req, res) => {
  const path = req.path;
  // 정적 파일(.js, .css, .png 등)은 홈으로 보내지 않고 통과 시도
  if (['/proxy', '/'].includes(path) || path.includes('.')) return;

  const referer = req.headers.referer;
  let domain = 'https://www.naver.com';
  
  if (referer && referer.includes('url=')) {
    try {
      const prevUrl = new URL(new URL(referer).searchParams.get('url'));
      domain = prevUrl.origin;
    } catch (e) {}
  }

  // 모르는 경로는 이전 사이트 도메인을 붙여서 프록시로 재진입
  const recovered = domain + req.originalUrl;
  console.log("경로 이탈 감지 -> 복원:", recovered);
  res.redirect('/proxy?url=' + encodeURIComponent(recovered));
});

app.listen(port, () => { console.log('Final Guarded Proxy Running'); });

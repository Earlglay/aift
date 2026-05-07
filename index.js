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

  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin 
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    // 보안 헤더 삭제 (브라우저가 사이트의 리다이렉트 명령을 무시하도록 함)
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 1. 모든 정적 링크 치환
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
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('script', 'src');

      // 2. [강력] 브라우저 이동 함수 및 도메인 감시 로직 무력화
      const injectScript = `
        <script>
          (function() {
            const currentOrigin = window.location.origin;
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(currentOrigin)) return abs;
                return currentOrigin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // [핵심] 사이트의 리다이렉트 시도를 물리적으로 차단
            window.onbeforeunload = function() { return "이동하시겠습니까?"; }; // 튕기기 전 경고창 (선택 사항)
            
            // Location 조작 방어
            const noop = () => {};
            Object.defineProperty(window, 'onbeforeunload', { configurable: false, writeable: false, value: noop });

            // History 및 이동 관련 API 장악
            const patch = (obj, prop) => {
              const org = obj[prop];
              obj[prop] = function(s, t, u) {
                if (u) window.location.href = wrap(u);
                else return org.apply(this, arguments);
              };
            };
            patch(history, 'pushState');
            patch(history, 'replaceState');

            // 클릭 가로채기 (가장 공격적인 단계)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 폼 전송 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
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
    res.redirect('/');
  }
});

// 기타 경로 처리
app.get('*', (req, res) => { res.redirect('/'); });

app.listen(port, () => { console.log('Anti-Bounce Proxy Active'); });

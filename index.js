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
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    
    // [중요] 네이버 접속 불가는 대부분 '쿠키'와 'Referer' 유실 문제임
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin,
        'Cookie': req.headers.cookie || '', // 브라우저의 쿠키를 대상 사이트로 전달
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    // 대상 사이트가 주는 쿠키를 우리 브라우저에 저장 (세션 유지)
    if (response.headers['set-cookie']) {
      res.set('set-cookie', response.headers['set-cookie']);
    }

    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

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
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('script', 'src'); rewrite('link', 'href');

      // [구글 무한 새로고침 저격] 브라우저 이동 관련 API 강제 고정
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            
            // 1. 구글이 주소창을 멋대로 바꾸지 못하게 History API 동결
            const freeze = (obj, prop, value) => {
              Object.defineProperty(obj, prop, { configurable: false, writable: false, value: value });
            };

            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(window.location.host)) return abs;
                return PROXY_URL + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // pushState, replaceState 가로채서 프록시 유지
            const patch = (m) => {
              const org = history[m];
              history[m] = function(s, t, u) {
                if (u && !u.includes(window.location.host)) {
                  window.location.href = wrap(u);
                } else {
                  return org.apply(this, arguments);
                }
              };
            };
            patch('pushState'); patch('replaceState');

            // 2. 폼 전송/클릭 가로채기 (최우선순위)
            window.addEventListener('submit', e => {
              const form = e.target;
              if (!form.action.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = wrap(form.action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            window.addEventListener('click', e => {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 3. 도메인 속이기 (네이버 차단 방지)
            try { Object.defineProperty(document, 'domain', { get: () => 'naver.com' }); } catch(e) {}
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

app.use((req, res) => {
  if (req.path === '/' || req.path === '/proxy') return;
  res.status(404).redirect('/');
});

app.listen(port, () => { console.log('Final Fix Proxy Active'); });

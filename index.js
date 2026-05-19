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

// [추가] 백그라운드 핑 엔드포인트: 사용자의 현재 위치를 서버에 동기화
app.get('/proxy/ping', (req, res) => {
  res.status(204).end();
});

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 1. 유실된 URL 복구 (Referer 기반 도메인 추론)
  if (!targetUrl) {
    const q = req.query.query || req.query.q;
    const referer = req.headers.referer;
    if (q && referer && referer.includes('url=')) {
      try {
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        targetUrl = prevUrl.origin + prevUrl.pathname + (prevUrl.search ? prevUrl.search + '&' : '?') + (req.query.query ? 'query=' : 'q=') + encodeURIComponent(q);
      } catch(e) { return res.redirect('/'); }
    } else { return res.redirect('/'); }
  }

  try {
    const urlObj = new URL(targetUrl);
    Object.keys(req.query).forEach(key => { if (key !== 'url') urlObj.searchParams.set(key, req.query[key]); });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 12000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 2. 서버 측 정적 리소스 치환
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

      // 3. [핵심] OneLink 스마트 스크립트 원리를 적용한 클라이언트 로직
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

            // 1) 동적 링크 감시 및 치환 (OneLink의 querySelectorAll 로직 응용)
            const smartRewriter = () => {
              document.querySelectorAll('a[href], form[action]').forEach(el => {
                const attr = el.tagName === 'A' ? 'href' : 'action';
                const originalValue = el.getAttribute(attr);
                if (originalValue && !originalValue.includes(currentOrigin) && !originalValue.startsWith('javascript:')) {
                  el.setAttribute(attr, wrap(originalValue));
                }
              });
            };

            // 페이지 로드 직후 및 1.5초 뒤(지연 생성 대응) 실행
            smartRewriter();
            setTimeout(smartRewriter, 1500); 
            
            // 2) 백그라운드 핑 (OneLink의 fetch no-cors 응용)
            fetch('/proxy/ping?last_pos=' + encodeURIComponent(window.location.href), { mode: 'no-cors' }).catch(() => {});

            // 3) 클릭/전송 최우선 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                window.location.href = wrap(a.href);
              }
            }, true);

            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentOrigin)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = wrap(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // 4) 네이버 등 보안 도메인 속이기
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

// 4. 경로 이탈 시 자동 복구 와일드카드
app.get('*', (req, res) => {
  const referer = req.headers.referer;
  if (referer && referer.includes('url=')) {
    try {
      const prev = new URL(new URL(referer).searchParams.get('url'));
      return res.redirect('/proxy?url=' + encodeURIComponent(prev.origin + req.originalUrl));
    } catch(e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Smart Proxy Server Active'); });

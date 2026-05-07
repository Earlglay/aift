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

  // 1. 검색어 파라미터 유실 시 복구 로직 (네이버/구글/레딧 대응)
  if (!targetUrl) {
    const q = req.query.query || req.query.q;
    const referer = req.headers.referer;
    if (q && referer && referer.includes('url=')) {
      try {
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        // 구글/레딧 등은 q= 검색어를 보편적으로 사용함
        targetUrl = `${prevUrl.origin}${prevUrl.pathname}?q=${encodeURIComponent(q)}`;
      } catch(e) { return res.redirect('/'); }
    } else { return res.redirect('/'); }
  }

  try {
    const urlObj = new URL(targetUrl);
    
    // 2. 브라우저 보안 헤더 우회 설정
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': urlObj.origin // 타겟 사이트 본래 도메인을 속여서 보냄
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    // CSP(보안 정책) 헤더 제거 (무한 새로고침의 주원인)
    res.removeHeader('content-security-policy');
    res.removeHeader('content-security-policy-report-only');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 3. 서버 측 리소스 주소 치환
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

      // 4. [수정] 무한 루프를 방지하는 온화한 가로채기 스크립트
      const injectScript = `
        <script>
          (function() {
            const currentHost = window.location.host;
            const wrap = (u) => {
              if(!u || typeof u !== 'string' || u.startsWith('javascript:') || u.startsWith('#')) return u;
              try {
                const abs = new URL(u, window.location.href).href;
                if (abs.includes(currentHost)) return abs;
                return window.location.origin + '/proxy?url=' + encodeURIComponent(abs);
              } catch(e) { return u; }
            };

            // 클릭 가로채기 (캡처링 단계)
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentHost)) {
                e.preventDefault();
                window.location.href = wrap(a.href);
              }
            }, true);

            // 폼 전송 (검색 등) 가로채기
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(currentHost)) {
                e.preventDefault();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                const finalUrl = action.split('?')[0] + '?' + sp.toString();
                window.location.href = wrap(finalUrl);
              }
            }, true);

            // 무한 새로고침 방지를 위해 history 조작은 감시만 하고 강제 이동은 자제
            const orgPush = history.pushState;
            history.pushState = function() {
              try { return orgPush.apply(this, arguments); } catch(e) {}
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

// 경로 이탈 시 홈으로 튕기는 대신 마지막 도메인으로 복구 시도
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

app.listen(port, () => { console.log('Proxy Fixed - Loop Guard Active'); });

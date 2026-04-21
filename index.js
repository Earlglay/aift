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

  // [수정 1] URL이 없을 때 범용 검색어 처리 (네이버 q/query, 구글 q 등 대응)
  if (!targetUrl) {
    const q = req.query.query || req.query.q || req.query.searchTerm;
    const referer = req.headers.referer;

    if (q && referer && referer.includes('url=')) {
      try {
        // 이전 페이지 도메인을 찾아서 검색 주소 조립
        const prevUrl = new URL(new URL(referer).searchParams.get('url'));
        const searchPath = prevUrl.hostname.includes('google') ? '/search?q=' : 
                           prevUrl.hostname.includes('naver') ? '/search.naver?query=' : 
                           prevUrl.pathname; // 일반 사이트는 현재 경로 유지
        targetUrl = prevUrl.origin + searchPath + encodeURIComponent(q);
      } catch(e) {
        return res.redirect('/');
      }
    } else {
      return res.redirect('/');
    }
  }

  try {
    const urlObj = new URL(targetUrl);
    // 현재 요청의 모든 쿼리를 타겟 URL에 병합 (검색어 누락 방지)
    Object.keys(req.query).forEach(key => {
      if (key !== 'url') urlObj.searchParams.set(key, req.query[key]);
    });
    targetUrl = urlObj.href;

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      responseType: 'arraybuffer',
      timeout: 12000,
      validateStatus: false 
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 경로 치환
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

      // [수정 2] 범용 폼 전송 가로채기 스크립트
      const injectScript = `
        <script>
          (function() {
            const currentOrigin = window.location.origin;
            
            // 모든 클릭 가로채기
            window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(currentOrigin)) {
                e.preventDefault();
                window.location.href = currentOrigin + '/proxy?url=' + encodeURIComponent(a.href);
              }
            }, true);

            // [핵심] 범용 폼(검색창) 처리
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              
              if (!action.includes(currentOrigin)) {
                e.preventDefault();
                const fd = new FormData(form);
                const params = new URLSearchParams();
                for (const [k, v] of fd.entries()) params.append(k, v);
                
                // 검색어와 기존 파라미터를 합쳐서 프록시로 전송
                const finalUrl = action.split('?')[0] + '?' + params.toString();
                window.location.href = currentOrigin + '/proxy?url=' + encodeURIComponent(finalUrl);
              }
            }, true);

            // History API 보호 (도메인 튕김 방지)
            const patch = (u) => u && !u.includes(currentOrigin) ? (currentOrigin + '/proxy?url=' + encodeURIComponent(new URL(u, window.location.href).href)) : u;
            const orgPush = history.pushState;
            history.pushState = function(s, t, u) { 
                const newUrl = patch(u);
                return (newUrl && newUrl !== u) ? (window.location.href = newUrl) : orgPush.apply(this, arguments); 
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

// [수정 3] 지능형 와일드카드 복구
app.get('*', (req, res) => {
  const path = req.path;
  if (['/proxy', '/'].includes(path) || path.includes('.')) return res.redirect('/');
  
  const referer = req.headers.referer;
  if (referer && referer.includes('url=')) {
    try {
      const prevUrl = new URL(new URL(referer).searchParams.get('url'));
      return res.redirect('/proxy?url=' + encodeURIComponent(prevUrl.origin + req.originalUrl));
    } catch(e) {}
  }
  res.redirect('/');
});

app.listen(port, () => { console.log('Universal Proxy Active'); });

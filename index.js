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
    
    // [개선] 사이트 차단을 막기 위한 헤더 최소화 및 표준화
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': urlObj.origin, // 접속 불가 방지를 위해 도메인 일치시킴
        'Connection': 'keep-alive'
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false 
    });

    // 보안 정책 삭제 (브라우저 차단 해제)
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // 모든 링크를 절대 경로로 바꾼 후 프록시 주소로 감쌈
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              const abs = new URL(val, targetUrl).href;
              $(el).attr(attr, '/proxy?url=' + encodeURIComponent(abs));
            } catch (e) {}
          }
        });
      };
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('script', 'src'); rewrite('link', 'href');

      // [핵심] 튕김 방지 스크립트 (최소화된 안정 버전)
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            
            // 1. 모든 클릭 가로채기 (강제 리다이렉트 방지)
            window.addEventListener('click', e => {
              const a = e.target.closest('a');
              if (a && a.href && !a.href.includes(window.location.host)) {
                e.preventDefault();
                window.location.href = PROXY_URL + encodeURIComponent(a.href);
              }
            }, true);

            // 2. 폼 전송 (검색) 가로채기
            window.addEventListener('submit', e => {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                window.location.href = PROXY_URL + encodeURIComponent(action.split('?')[0] + '?' + sp.toString());
              }
            }, true);

            // 3. OneLink 방식의 지연 실행: JS로 나중에 생성된 링크 보호
            setInterval(() => {
              document.querySelectorAll('a[href]:not([data-proxy])').forEach(el => {
                if(!el.href.includes(window.location.host)) {
                  el.setAttribute('data-proxy', 'true');
                  el.href = PROXY_URL + encodeURIComponent(el.href);
                }
              });
            }, 2000);
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

// [중요] 무한 튕김의 원인이었던 '*' 와일드카드 제거
// 대신 public 폴더의 정적 파일만 처리
app.use((req, res) => res.status(404).redirect('/'));

app.listen(port, () => { console.log('Stable Proxy Active'); });

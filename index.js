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
    
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 10000,
      validateStatus: false 
    });

    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 페이지일 때만 주소 치환 및 스타일 복구 작업 진행
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // [수정] 무조건 모든 스크립트를 지우지 않고, 튕김을 유발하는 외부 리다이렉트 소스만 선별 제거
      $('script').each((i, el) => {
        const src = $(el).attr('src');
        // 위키백과 내부 자바스크립트는 살려두고, 외국의 수상한 보안/광고 스크립트만 타겟팅해 제거
        if (src && (src.includes('analytics') || src.includes('doubleclick'))) {
          $(el).remove();
        }
      });

      const myOrigin = `${req.protocol}://${req.get('host')}`;
      
      // 주소 치환 함수 기믹 고도화
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              // 상대 경로들을 원래 사이트 도메인 기준으로 절대 경로(https://...)로 완벽 변환
              const abs = new URL(val, targetUrl).href;
              
              // 스타일시트(CSS)와 이미지(img)는 우리 프록시 주소를 거치지 않고 
              // 브라우저가 원본 주소에서 직접 다운로드하도록 내버려둠 (화면 깨짐 방지 + 서버 메모리 절약)
              if (tag === 'link' || tag === 'img') {
                $(el).attr(attr, abs);
              } else {
                // 클릭해서 이동해야 하는 일반 링크(a)나 검색(form)만 우리 프록시 주소로 가두기
                $(el).attr(attr, `${myOrigin}/proxy?url=${encodeURIComponent(abs)}`);
              }
            } catch (e) {}
          }
        });
      };
      
      rewrite('a', 'href'); 
      rewrite('form', 'action'); 
      rewrite('img', 'src'); 
      rewrite('link', 'href'); // CSS 디자인 파일 경로 정상화

      // 검색 시 브라우저 경고창 방지를 위한 경량화 가로채기 폼 스크립트 주입
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            window.addEventListener('submit', function(e) {
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
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      
      return res.send($.html());
    }
    
    // 이미 지나간 정적 파일 요청은 그대로 통과
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    return res.redirect('/');
  }
});

app.use((req, res) => res.redirect('/'));

app.listen(port, () => { console.log('Wiki-Optimized Proxy Active'); });

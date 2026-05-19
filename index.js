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
    
    // 1. 진짜 브라우저처럼 정중하게 요청 (차단 회피)
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 8000, // 타임아웃 방지를 위해 8초 제한
      validateStatus: false 
    });

    // 보안 헤더 무력화
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // [🚨 핵심] 구글/네이버의 튕김 스크립트 원천 제거
      // 사이트 자체 JS가 실행되지 않게 만들어서 주소창 조작(튕김)을 물리적으로 불가능하게 만듭니다.
      $('script').remove(); 

      // 2. 모든 정적 링크 치환
      const myOrigin = `${req.protocol}://${req.get('host')}`;
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              const abs = new URL(val, targetUrl).href;
              $(el).attr(attr, `${myOrigin}/proxy?url=${encodeURIComponent(abs)}`);
            } catch (e) {}
          }
        });
      };
      rewrite('a', 'href'); rewrite('form', 'action'); rewrite('img', 'src'); rewrite('link', 'href');

      // 3. [대체 스크립트] 원본 JS 대신 우리가 만든 '검색 전용 가로채기 스크립트' 딱 하나만 주입
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            
            // 검색(Form 전송) 버튼 누를 때 튕기지 않고 우리 프록시로 유도
            window.addEventListener('submit', function(e) {
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              
              if (!action.includes(window.location.host)) {
                e.preventDefault();
                
                // 검색어 파라미터 추출
                const fd = new FormData(form);
                const sp = new URLSearchParams();
                for (const [k, v] of fd.entries()) sp.append(k, v);
                
                const finalUrl = action.split('?')[0] + '?' + sp.toString();
                window.location.href = PROXY_URL + encodeURIComponent(finalUrl);
              }
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      
      return res.send($.html());
    }
    
    // HTML이 아닌 이미지 등의 리소스는 그대로 중계
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    return res.redirect('/');
  }
});

// 안전장치: 이상한 경로로 빠지면 무조건 메인으로
app.use((req, res) => res.redirect('/'));

app.listen(port, () => { console.log('Ultra-Light Safe Proxy Active'); });

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// public 폴더의 정적 파일(index.html 등) 제공
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    
    // 1. 실제 사용자인 것처럼 헤더를 구성하여 대상 사이트에 요청
    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Referer': urlObj.origin
      },
      responseType: 'arraybuffer',
      timeout: 10000, // 10초 타임아웃 제한
      validateStatus: false 
    });

    // 브라우저의 보안 차단 헤더 해제
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML 페이지일 때만 정밀 주소 치환 및 보안 우회 스크립트 주입 진행
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 튕김을 유발하는 외부 광고/분석 자바스크립트만 선별하여 무력화 (사이트 UI용 JS는 보존)
      $('script').each((i, el) => {
        const src = $(el).attr('src');
        if (src && (src.includes('analytics') || src.includes('doubleclick') || src.includes('pagead'))) {
          $(el).remove();
        }
      });

      const myOrigin = `${req.protocol}://${req.get('host')}`;
      
      // 태그별 주소 변환 규칙
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              // 상대 경로들을 대상 도메인 기준의 절대 경로(https://...)로 완벽 복원
              const abs = new URL(val, targetUrl).href;
              
              // [디자인 유지 요인] 이미지와 CSS 스타일시트는 브라우저가 원본 주소에서 직접 긁어오게 둠
              if (tag === 'link' || tag === 'img') {
                $(el).attr(attr, abs);
              } else {
                // 클릭이 발생하는 일반 링크(a)나 폼 전송(form)만 우리 프록시 주소 안에 가둠
                $(el).attr(attr, `${myOrigin}/proxy?url=${encodeURIComponent(abs)}`);
              }
            } catch (e) {}
          }
        });
      };
      
      rewrite('a', 'href'); 
      rewrite('form', 'action'); 
      rewrite('img', 'src'); 
      rewrite('link', 'href'); // CSS 경로 고정

      // [🚨 브라우저 경고 및 메인 튕김 무력화 핵심 스크립트 주입]
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            
            // 브라우저가 '양식 제출'로 인식하여 경고창을 띄우는 행위를 원천 차단 (이벤트 캡처링)
            window.addEventListener('submit', function(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              
              const form = e.target;
              const action = new URL(form.action || window.location.href, window.location.href).href;
              
              // 폼 내부의 입력값(검색어 등)을 자바스크립트로 직접 강제 추출
              const fd = new FormData(form);
              const sp = new URLSearchParams();
              for (const [k, v] of fd.entries()) {
                if(v) sp.append(k, v);
              }
              
              // 양식 제출 행위가 아닌, 주소창에 파라미터를 붙여 '단순 주소 이동'하는 방식으로 가공 세탁
              const finalUrl = action.split('?')[0] + '?' + sp.toString();
              
              // 우리 프록시 주소를 안전하게 덮어씌워 페이지를 전환시킴
              window.location.href = PROXY_URL + encodeURIComponent(finalUrl);
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      
      return res.send($.html());
    }
    
    // HTML이 아닌 기타 정적 이미지 등의 요청은 그대로 중계
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy General Error:", error.message);
    return res.redirect('/');
  }
});

// 지정되지 않은 엉뚱한 경로로 빠질 시 메인 화면으로 복귀시켜 먹통 방지
app.use((req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Smart Ultra-Light Proxy Server is running on port ${port}`);
});

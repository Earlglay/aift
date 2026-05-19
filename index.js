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

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // 외부 광고/분석 스크립트만 청소
      $('script').each((i, el) => {
        const src = $(el).attr('src');
        if (src && (src.includes('analytics') || src.includes('doubleclick') || src.includes('pagead'))) {
          $(el).remove();
        }
      });

      const myOrigin = `${req.protocol}://${req.get('host')}`;
      
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              const abs = new URL(val, targetUrl).href;
              
              if (tag === 'link' || tag === 'img') {
                $(el).attr(attr, abs);
              } else {
                $(el).attr(attr, `${myOrigin}/proxy?url=${encodeURIComponent(abs)}`);
              }
            } catch (e) {}
          }
        });
      };
      
      rewrite('a', 'href'); 
      rewrite('form', 'action'); 
      rewrite('img', 'src'); 
      rewrite('link', 'href');

      // [🚨 핵심 수정] 현재 타겟 사이트의 '진짜 도메인 주소'를 자바스크립트에 심어줍니다.
      const injectScript = `
        <script>
          (function() {
            const PROXY_URL = window.location.origin + '/proxy?url=';
            // 현재 프록시가 열고 있는 진짜 원본 사이트 도메인 (예: https://ko.wikipedia.org)
            const TARGET_ORIGIN = "${urlObj.origin}"; 
            
            window.addEventListener('submit', function(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              
              const form = e.target;
              let actionAttr = form.getAttribute('action') || '';
              
              // 목적지 주소가 /w/index.php 같은 상대경로라면 타겟 도메인을 강제로 붙여서 절대경로로 만듦
              let absoluteAction;
              try {
                absoluteAction = new URL(actionAttr, TARGET_ORIGIN).href;
              } catch(err) {
                absoluteAction = new URL(window.location.href).searchParams.get('url');
              }
              
              const fd = new FormData(form);
              const sp = new URLSearchParams();
              for (const [k, v] of fd.entries()) {
                if(v) sp.append(k, v);
              }
              
              // 완성된 진짜 주소에 파라미터를 결합하고 프록시 주소로 감싸서 이동
              const finalUrl = absoluteAction.split('?')[0] + '?' + sp.toString();
              window.location.href = PROXY_URL + encodeURIComponent(finalUrl);
            }, true);
          })();
        </script>
      `;
      $('head').prepend(injectScript);
      
      return res.send($.html());
    }
    
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy General Error:", error.message);
    return res.redirect('/');
  }
});

app.use((req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Smart Fix Proxy Server is running on port ${port}`);
});

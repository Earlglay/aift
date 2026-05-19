const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// public 폴더의 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  try {
    const urlObj = new URL(targetUrl);
    
    // 대상 사이트 소스코드 가져오기
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

    // 브라우저 프레임 제한 해제
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));
      const myOrigin = `${req.protocol}://${req.get('host')}`;
      
      // 태그 주소 치환 핵심 로직
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
            try {
              // 상대 경로들을 원래 사이트 도메인 기준의 절대 경로(https://...)로 변환
              const abs = new URL(val, targetUrl).href;
              
              // [중요] 디자인용 CSS와 이미지는 원본 주소에서 직접 받게 둠 (깨짐 방지)
              if (tag === 'link' || tag === 'img') {
                $(el).attr(attr, abs);
              } else {
                // 일반 링크(a)와 검색창(form) 주소는 우리 프록시 주소로 감쌈
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

      // 주소창 강제 조작 스크립트 다 빼고, 상대 경로 파괴 방지용 <base> 태그 하나만 깔끔하게 주입
      $('head').prepend(`<base href="${urlObj.origin}/">`);
      
      return res.send($.html());
    }
    
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    return res.redirect('/');
  }
});

// 완전히 길을 잃은 요청만 메인으로 복귀
app.use((req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Stable Clean Proxy Server is running on port ${port}`);
});

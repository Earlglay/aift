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
      const myOrigin = `${req.protocol}://${req.get('host')}`;
      
      // [핵심] 위키백과 내부 검색창(Form)의 전송 방식을 강제로 안전한 GET으로 변경
      $('form').attr('method', 'GET');

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

      // 상대 경로가 깨져서 메인으로 튕기는 걸 방지하는 베이스 태그 주입
      $('head').prepend(`<base href="${urlObj.origin}/">`);
      
      return res.send($.html());
    }
    
    return res.send(response.data);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    return res.redirect('/');
  }
});

app.use((req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Original Working Proxy Server is running on port ${port}`);
});

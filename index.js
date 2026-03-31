const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));

// 1. 메인 화면 보여주기
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 핵심 프록시 기능 (사이트 복제)
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.send('접속할 주소를 입력해주세요.');
  }

  try {
    // 상대방 사이트에 대신 접속해서 HTML 가져오기
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);

    // [중요] 모든 이미지 주소를 '절대 경로'로 수정 (이미지가 깨지지 않게)
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && !src.startsWith('http')) {
        try {
          $(el).attr('src', new URL(src, targetUrl).href);
        } catch (e) { /* 무시 */ }
      }
    });

    // 결과를 브라우저에 뿌려주기
    res.send($.html());

  } catch (error) {
    res.status(500).send(`사이트에 접속할 수 없습니다: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

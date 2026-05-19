const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 정적 파일 제공 (public 폴더 내의 index.html 등)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 전역 브라우저 인스턴스 (요청마다 브라우저를 새로 켜면 Render 서버가 바로 터집니다)
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 공유 메모리 부족으로 인한 크래시 방지
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Render의 부족한 메모리(512MB)를 아끼기 위해 단일 프로세스로 실행
        '--disable-gpu'
      ]
    });
  }
  return browserInstance;
}

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // [핵심] Render 메모리 절약을 위해 이미지, 스타일시트, 폰트, 미디어 로딩 전면 차단
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // 실제 브라우저처럼 보이도록 User-Agent 설정
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // 자바스크립트 기본 실행 직후(DOM 로드 완료) 바로 소스코드를 낚아챔 (속도 최적화)
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Puppeteer 크롬이 자바스크립트를 해석해서 만들어낸 최종 HTML 결과물 백업
    let content = await page.content();

    // HTML 내부의 모든 링크(href, src, action)를 우리 프록시 주소로 강제 치환
    const myOrigin = `${req.protocol}://${req.get('host')}`;
    
    content = content.replace(/(href|src|action)=["']((?!javascript:|data:|#)[^"']+)["']/g, (match, attr, url) => {
      try {
        // 상대 경로를 타겟 URL 기준으로 절대 경로 변환
        const absoluteUrl = new URL(url, targetUrl).href;
        // 우리 프록시 주소를 앞에 붙여서 리턴
        return `${attr}="${myOrigin}/proxy?url=${encodeURIComponent(absoluteUrl)}"`;
      } catch (e) {
        return match;
      }
    });

    // 자바스크립트 내부의 상대 경로 기준점 고정을 위한 <base> 태그 주입
    const urlObj = new URL(targetUrl);
    content = content.replace('<head>', `<head><base href="${urlObj.origin}/">`);

    // 클라이언트에 HTML 전송
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(content);

  } catch (error) {
    console.error("Puppeteer Proxy Error:", error.message);
    return res.status(500).send("페이지를 로드하는 중 오류가 발생했습니다. (Render 메모리 초과 또는 타임아웃)");
  } finally {
    // 메모리 누수를 막기 위해 사용한 탭(페이지)은 반드시 닫음
    if (page) await page.close();
  }
});

// 정적 파일 및 프록시 외의 비정상 경로는 메인으로 안전하게 리다이렉트 (튕김 루프 방지)
app.use((req, res) => {
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Puppeteer Light Proxy Server is running on port ${port}`);
});

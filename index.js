const express = require('express');
const app = express();
const path = require('path'); // 파일 경로 처리를 위해 추가
const port = process.env.PORT || 3000;

// public 폴더 안에 있는 파일을 자동으로 서빙합니다.
app.use(express.static('public'));

// 기본 접속 시 index.html을 보여줍니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

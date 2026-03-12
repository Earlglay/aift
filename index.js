const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// 1. Neon DB 연결 설정
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Render/Neon 환경에서 필수
  }
});

app.get('/', async (req, res) => {
  try {
    // 2. 'test' 테이블에서 레코드 하나만 조회 (가장 먼저 들어온 데이터)
    const result = await pool.query('SELECT name FROM test LIMIT 1');

    if (result.rows.length > 0) {
      const userName = result.rows[0].name;
      res.send(`<h1>HELLO ${userName}</h1>`);
    } else {
      res.send('<h1>HELLO! (데이터가 없습니다)</h1>');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('DB 연결 에러가 발생했습니다.');
  }
});

app.listen(port, () => {
  console.log(`서버가 포트 ${port}에서 실행 중입니다.`);
});

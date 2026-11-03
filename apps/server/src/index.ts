// 서버 진입점: express 앱을 만들고, MongoDB에 연결한 뒤, 포트를 연다.
import express, { type ErrorRequestHandler } from 'express';
import { Server as SocketServer } from 'socket.io';
import { config } from './config';
import { checkMongo, closeClient } from './db';
import { HttpError } from './names';
import { startRealtime } from './realtime';
import { mutateRouter } from './routes/mutate';
import { readRouter } from './routes/read';
import { refsRouter } from './routes/refs';

const app = express();
app.use(express.json({ limit: '10mb' }));

// 상태 확인용 — 서버가 살아 있는지, Mongo에 닿는지, replica set인지
app.get('/api/health', async (_req, res) => {
  const mongo = await checkMongo();
  res.status(mongo.ok ? 200 : 503).json({ server: 'ok', mongo });
});

app.use('/api', readRouter);
app.use('/api', mutateRouter);
app.use('/api', refsRouter);

// 위에서 처리하지 못한 /api 요청
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 라우트에서 던진 에러 → JSON 응답. express 5는 async 핸들러의 에러도 여기로 넘겨 준다.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[server]', err);
  // 내부 에러 내용(접속 주소 등)이 밖으로 새지 않게 일반 메시지만 보낸다
  res.status(500).json({ error: 'internal error' });
};
app.use(errorHandler);

const start = async () => {
  // 연결이 안 돼도 서버는 띄운다 — /api/health에서 원인을 볼 수 있고, 요청마다 다시 연결을 시도한다.
  const mongo = await checkMongo();
  if (mongo.ok) {
    console.log(`[mongo] 연결됨 — v${mongo.version}, replica set: ${mongo.replicaSet ?? '없음(changeStream 불가)'}`);
  } else {
    console.error('[mongo] 연결 실패:', mongo.error);
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`[server] http://${config.host}:${config.port}`);
  });

  // 실시간 변경 전달 — 같은 포트의 /socket.io 경로. CORS를 열지 않으므로 다른 사이트의 페이지는 붙을 수 없다
  // (개발 중엔 Vite 프록시를 거쳐 같은 주소로 들어온다)
  const io = new SocketServer(server, { serveClient: false });
  const realtime = startRealtime(io);

  // Ctrl+C / 재시작 시 Mongo 연결을 정리하고 종료
  const shutdown = async () => {
    await realtime.stop();
    io.close();
    server.close();
    await closeClient();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

void start();

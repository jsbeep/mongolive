// 서버 진입점: express 앱을 만들고, MongoDB에 연결한 뒤, 포트를 연다.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { Server as SocketServer } from 'socket.io';
import { allowSocket, authRouter, guard, hasValidSession } from './auth';
import { loadAuthData } from './authFile';
import { config } from './config';
import { checkMongo, closeClient } from './db';
import { HttpError } from './names';
import { startRealtime } from './realtime';
import { createAppServer } from './tls';
import { mutateRouter } from './routes/mutate';
import { readRouter } from './routes/read';
import { aggregateRouter } from './routes/aggregate';
import { metricsRouter } from './routes/metrics';
import { refsRouter } from './routes/refs';
import { diagnosticsRouter } from './routes/diagnostics';
import { settingsRouter } from './routes/settings';
import { connectionsRouter } from './routes/connections';
import { loadConnections, onConnectionsChange } from './connections';
import { getServerSettings, loadServerSettings, onServerSettingsChange } from './settings';

const app = express();
// 모든 응답에 붙이는 보안 헤더 (문지기가 거절한 응답에도)
//   Referrer-Policy: 다른 사이트로 넘어갈 때 이 앱의 주소를 보내지 않는다
//   frame-ancestors / X-Frame-Options: 다른 사이트가 이 앱을 iframe에 넣어 클릭을 가로채지 못하게(클릭재킹)
app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
// 문지기가 맨 앞 — 거절할 요청은 본문(최대 10MB)을 읽기도 전에 돌려보낸다
app.use(guard);
// 로그인/로그아웃/상태 — 본문 제한이 작은 자기 파서를 쓰므로 10MB 파서보다 앞에 둔다
app.use('/api', authRouter);
app.use(express.json({ limit: '10mb' }));

// 상태 확인용 — 서버가 살아 있는지, Mongo에 닿는지, replica set인지
app.get('/api/health', async (_req, res) => {
  const mongo = await checkMongo();
  res.status(mongo.ok ? 200 : 503).json({ server: 'ok', mongo });
});

app.use('/api', readRouter);
app.use('/api', aggregateRouter);
app.use('/api', mutateRouter);
app.use('/api', refsRouter);
app.use('/api', metricsRouter);
app.use('/api', diagnosticsRouter);
app.use('/api', settingsRouter);
app.use('/api', connectionsRouter);

// 위에서 처리하지 못한 /api 요청
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 빌드된 웹 화면 — 개발 중엔 Vite가 맡으므로 dist가 없으면 건너뛴다.
// 모르는 주소(GET)는 index.html로 — 화면 안의 이동은 React가 처리한다.
const webIndex = join(config.webDist, 'index.html');
const servesWeb = existsSync(webIndex);
if (servesWeb) {
  app.use(express.static(config.webDist, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(webIndex));
}

// 라우트에서 던진 에러 → JSON 응답. express 5는 async 핸들러의 에러도 여기로 넘겨 준다.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ ...err.body, error: err.message });
    return;
  }
  // express.json이 던지는 요청 쪽 잘못(본문이 너무 큼 413, 깨진 JSON 400) — expose는 '밖에 보여도 되는 메시지'라는 표시
  if (err?.expose === true && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[server]', err);
  // 내부 에러 내용(접속 주소 등)이 밖으로 새지 않게 일반 메시지만 보낸다
  res.status(500).json({ error: 'internal error' });
};
app.use(errorHandler);

// 출입증이 만료됐거나 비밀번호가 바뀌어(서명 키 교체) 무효가 된 실시간 연결을 끊는다.
// WebSocket은 처음 붙을 때만 문지기를 지나므로, 붙어 있는 동안은 따로 다시 확인해야 한다.
const SOCKET_RECHECK_MS = 60 * 1000;

const start = async () => {
  // 비밀번호가 없으면 아무도 들어올 수 없는 서버가 된다 — 켜지 말고 방법을 알려 준다
  if (config.authMode === 'password' && !loadAuthData(config.authFile)) {
    console.error('[auth] 비밀번호가 아직 없습니다. 먼저 정하세요:\n  corepack pnpm --filter @mongolive/server set-password');
    process.exit(1);
  }

  // 안전장치 설정(read-only, 보호 대상)은 첫 요청 전에 읽어 둔다 — 읽기 전에 쓰기가 들어오면 막을 수 없다
  await loadServerSettings();
  if (getServerSettings().readOnly) console.log('[settings] read-only 모드 — 쓰기를 모두 거절합니다');
  // 연결 목록도 첫 요청 전에 — 깨진 파일이면 덮어쓰지 않도록 여기서 멈춘다
  await loadConnections();

  // 연결이 안 돼도 서버는 띄운다 — /api/health에서 원인을 볼 수 있고, 요청마다 다시 연결을 시도한다.
  const mongo = await checkMongo();
  if (mongo.ok) {
    console.log(`[mongo] 연결됨 — v${mongo.version}, replica set: ${mongo.replicaSet ?? '없음(changeStream 불가)'}`);
  } else {
    console.error('[mongo] 연결 실패:', mongo.error);
  }

  const { server, scheme, stop: stopTls } = createAppServer(app, config.tls);
  server.listen(config.port, config.host, () => {
    console.log(`[server] ${scheme}://${config.host}:${config.port} (AUTH_MODE=${config.authMode})`);
    if (servesWeb) console.log(`[server] 웹 화면도 내줍니다 — ${config.webDist}`);
    if (!config.loopbackOnly && scheme === 'http') {
      // ALLOW_INSECURE_HTTP=true로 일부러 허용한 경우에만 여기 온다(config.ts)
      console.warn('[auth] 경고: HTTPS 없이 외부에 열려 있습니다(ALLOW_INSECURE_HTTP). 같은 네트워크의 누구든 비밀번호와 쿠키를 엿볼 수 있습니다.');
    }
  });

  // 실시간 변경 전달 — 같은 포트의 /socket.io 경로(개발 중엔 Vite 프록시를 거쳐 같은 주소로 들어온다).
  // WebSocket은 CORS를 따르지 않아서 express 쪽과 같은 문지기를 allowRequest로 따로 세운다.
  const io = new SocketServer(server, { serveClient: false, allowRequest: allowSocket });
  const realtime = startRealtime(io);
  // 설정 창에서 Safety를 바꾸면 열려 있는 모든 탭에 알린다(편집 버튼 숨김/보임이 바로 바뀌게)
  const offSettings = onServerSettingsChange((settings) => io.emit('settings', settings));
  // 연결을 추가·수정·삭제하면 열려 있는 모든 탭의 연결 목록(웰컴 화면·사이드바)을 바꾼다
  const offConnections = onConnectionsChange((list) => io.emit('connections', list));
  const recheck = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (!hasValidSession(socket.request)) socket.disconnect(true);
    }
  }, SOCKET_RECHECK_MS);

  // Ctrl+C / 재시작 시 Mongo 연결을 정리하고 종료
  const shutdown = async () => {
    clearInterval(recheck);
    offSettings();
    offConnections();
    stopTls();
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

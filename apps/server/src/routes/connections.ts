// 연결 목록 (화면의 연결 카드·연결 모달)
//   GET    /api/connections          → ConnectionInfo[] (비밀 값은 가린 주소)
//   POST   /api/connections          ConnectionInput(uri 필수) → 201 ConnectionInfo
//   PUT    /api/connections/:id      ConnectionInput(보낸 항목만) → ConnectionInfo
//   DELETE /api/connections/:id      → 204
//   POST   /api/connections/test     ConnectionTestRequest → ConnectionTestResult
// 바뀌면 소켓 'connections'로 모든 탭에 새 목록을 알린다(index.ts).
//
// 로그인한 사람만 닿는다(guard). 테스트·저장은 서버가 그 주소로 접속하게 하므로 화면 밖(주소창 ?uri= 등)에서는
// 절대 받지 않는다 — 본문(JSON)으로만, Origin 검사를 지난 요청으로만.
import { Router } from 'express';
import { createConnection, deleteConnection, listConnections, resolveTestUri, updateConnection } from '../connections';
import { testMongoUri } from '../db';

export const connectionsRouter = Router();

connectionsRouter.get('/connections', (_req, res) => {
  res.json(listConnections());
});

connectionsRouter.post('/connections/test', async (req, res) => {
  res.json(await testMongoUri(resolveTestUri(req.body)));
});

connectionsRouter.post('/connections', async (req, res) => {
  res.status(201).json(await createConnection(req.body));
});

connectionsRouter.put('/connections/:id', async (req, res) => {
  res.json(await updateConnection(req.params.id, req.body));
});

connectionsRouter.delete('/connections/:id', async (req, res) => {
  await deleteConnection(req.params.id);
  res.status(204).end();
});

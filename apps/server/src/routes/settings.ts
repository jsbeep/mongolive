// 서버 쪽 설정(설정 창 › Safety)
//   GET /api/settings → ServerSettings
//   PUT /api/settings   ServerSettings 전체 → 저장된 값(모르는 값은 버린다). 바뀌면 소켓 'settings'로 모든 탭에 알린다
import { Router } from 'express';
import { getServerSettings, saveServerSettings } from '../settings';

export const settingsRouter = Router();

settingsRouter.get('/settings', (_req, res) => {
  res.json(getServerSettings());
});

settingsRouter.put('/settings', async (req, res) => {
  res.json(await saveServerSettings(req.body));
});

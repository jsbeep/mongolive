// 앱 전체가 쓰는 데이터 소스 인스턴스. 4단계에서 VITE_DATA_SOURCE=remote면
// 실제 서버 구현을 고르도록 여기서 분기한다.
import type { DataSource } from './dataSource';
import { createMockDataSource } from './mockDataSource';

export const api: DataSource = createMockDataSource();

export type { DataSource } from './dataSource';

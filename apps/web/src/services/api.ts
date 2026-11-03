// 앱 전체가 쓰는 데이터 소스 인스턴스.
//   VITE_DATA_SOURCE=remote → 실제 서버(apps/server)
//   그 외(기본)             → 브라우저 안의 Mock(localStorage)
// 값은 빌드 시점에 고정되므로 바꾸려면 개발 서버를 다시 띄운다.
import type { DataSource } from './dataSource';
import { createMockDataSource } from './mockDataSource';
import { createRemoteDataSource } from './remoteDataSource';

export const dataSourceKind: 'remote' | 'mock' = import.meta.env.VITE_DATA_SOURCE === 'remote' ? 'remote' : 'mock';

export const api: DataSource = dataSourceKind === 'remote' ? createRemoteDataSource() : createMockDataSource();

export type { DataSource } from './dataSource';

# 시스템 상호작용 분석

9-10 기준 (2026-11-18), C1·C2 반영 (2026-11-20). 코드를 grep으로 훑어 만든 지도다. 부하 칸은 측정값이 아니라 코드 기준 추정(상/중/하).
새 기능을 설계할 때 코드보다 이 문서를 먼저 읽는다. 바뀌면 같이 고친다.

## 0. 부품과 통신 경계

```
            B4                     B1                         B2
localStorage ◀──▶ [브라우저 web] ◀──REST ~45개──▶ [서버 server] ◀──드라이버 명령──▶ [MongoDB]
                       │          ◀──socket.io──▶       │      ◀──change stream──
                       │                                │ B3
                 DataSource 인터페이스              ~/.mongolive/
                 ├ remoteDataSource (실제)          auth / settings / connections / meta .json
                 └ mockDataSource  (데모)           metrics/ (모니터 기록)
```

| 경계 | 방식 | 코드 |
|---|---|---|
| B1 web ↔ server | REST(Express) + socket.io | `server/src/routes/*`, `realtime.ts` ↔ `web/src/services/remoteDataSource.ts` |
| B2 server ↔ Mongo | 명령·집계·change stream | `server/src/monitor/*`, `routes/read.ts`, `realtime.ts` |
| B3 server ↔ 디스크 | JSON 파일 + 기록 폴더 | `server/src/paths.ts` |
| B4 web ↔ localStorage | 연결별 저장, 설정 | `web/src/services/connectionStorage.ts` 외 |

web 안의 계약 경계는 `web/src/services/dataSource.ts`의 `DataSource` 인터페이스다. 응답 타입은 `packages/shared/src/contract.ts`에 있다.

## 1. Communication Matrix — 누가 누구한테 뭘 주고받나

### B1 REST

| 그룹 | 경로 | DataSource 메서드 | 응답 타입 | 서버가 읽는 곳 |
|---|---|---|---|---|
| 인증 | `/auth/me` `/auth/login` `/auth/logout` | (`services/auth.ts`, DataSource 밖) | — | auth.json |
| 연결 | `GET·POST /connections`, `PUT·DELETE /connections/:id` | `list/create/update/deleteConnection` | `ConnectionInfo` | connections.json |
| 설정 | `GET·PUT /settings` | `get/saveServerSettings` | `ServerSettings` | settings.json |
| 탐색 | `/databases`, `…/:db/collections`, `…/:col/documents`(GET·POST), `…/documents/:id`, `/oid/:oid` | `listDatabases` `getCollections` `getDocuments` `getDocumentById` 등 | `DocumentPage` 등 | Mongo |
| 참조 | `…/find-by-field`, `…/field-values`, `…/export` | `getReferenceCandidatesByField` `getFieldValueCandidates` `exportCollection` | | Mongo |
| 쿼리 | `POST …/explain` | `explainQuery` | `ExplainSummary` | Mongo |
| 집계 | `POST …/aggregate` (끊기면 취소, 개수 15초 제한) | `aggregate` `aggregateCounts` | `AggregateResult` | Mongo |
| 쓰기 | `POST /mutate` | `mutate` | `MutationResult` | Mongo |
| 메타 | `/meta/owned-oids(/:oid)`, `/meta/collections` | `listOwnedOids` `setOwnedOid` `get/importCollectionMetadata` | | meta.json |
| 진단 | `/diagnostics` | `getDiagnostics` | `Diagnostics` | Mongo `serverStatus` |
| 모니터 | 아래 표 (20개) | | | |

모니터 라우트 — **서버가 어디서 답을 꺼내나**가 핵심이다. history·slow·sizes·alerts는 `range=` 대신 `from=&to=`(날짜로 찾기, C2)도 받는다 — 응답 range `'custom'`, to는 지금까지로 줄이고 10분 미만이면 400. 나머지(메모리만)는 받지 않는다.

| 경로 | 메서드 | 답의 출처 |
|---|---|---|
| `/monitor/activity` | `getActivity` | 메모리 (change stream 누적) |
| `/monitor/last-writes` | `getLastWrites` | 메모리 |
| `/monitor/history`, `/history-info`, `DELETE /history` | `getHistory` (6h 1분·12h 2분·24h 5분 칸 …, custom = 점 360개 이하인 가장 짧은 칸·그 시각 분 기록이 지워졌으면 시·일로 `coarse` · 구간과 겹치는 파일만 연다) `getHistoryInfo` (`trimmed` = 디스크 한도로 지운 때·크기) `clearHistory` | 파일 metrics/ |
| `/monitor/backfill`, `/start`, `/stop` | `get/start/stopBackfill` | 메모리 + oplog 스캔 시작·정지 |
| `/monitor/slow` | `getSlowQueries` (`expand`=펼친 그룹만 command 포함, `dropped`=1분 50줄 상한으로 못 남긴 실행 수) | 메모리·파일 (slow 폴링이 채움) |
| `/monitor/top` | `getTop` | 메모리 (10초 틱) |
| `/monitor/replica` | `getReplica` | 메모리 (10초 틱) |
| `/monitor/alerts` | `getAlerts` | 메모리·파일 (custom = 구간과 겹친 알림) |
| `/monitor/transactions` | `getTransactions` | 메모리 |
| `/monitor/sizes`, `POST /sizes/measure` | `getSizes` `measureSizes` (custom = to 시점 값 + 구간 안 Δ) | 메모리 (1시간 측정)·파일 / 측정 시작 |
| `/monitor/operations`, `POST /operations/kill` | `getOperations` `killOperation` | **Mongo 직접** `$currentOp` `killOp` |
| `/monitor/indexes` | `getIndexes` | **Mongo 직접** `$indexStats` `$collStats` |
| `/monitor/oplog` | `getOplog` | **Mongo 직접** oplog.rs |
| `/monitor/startup-warnings` | `getStartupWarnings` | **Mongo 직접** `getLog` |

### B1 socket.io 이벤트

| 방향 | 이벤트 | 내용 | 받는 쪽 |
|---|---|---|---|
| web→server | `connection:use` | 이 탭이 쓰는 연결 id | |
| web→server | `view` | 지금 보이는 범위 (`setLiveView`) | |
| web→server | `log:subscribe/unsubscribe` | 활동 로그 구독 | |
| web→server | `monitor:subscribe/unsubscribe` | 모니터 구독 | |
| web→server | `presence` | `ClientPresence {visible, slowCard}` — 탭이 보이는지, Slow 카드가 떠 있는지 (`watchSlowCard`) | |
| web→server | `rtt` | 왕복 시간 측정 (`measureRtt`) | |
| server→web | `status` | `LiveStatus` (연결·live 상태). 밀렸다 따라잡은 탭엔 `{resync, skipped}` | 연결 room / 그 탭만 |
| server→web | `change` | `LiveChange` | 컬렉션 room (밀린 탭 제외) |
| server→web | `log`, `log:backlog` | `LiveLogEntry[]`. 따라잡은 탭엔 `log:backlog`를 다시 | 로그 구독자 (밀린 탭 제외) |

**밀린 탭 (backpressure)** — 탭으로 가는 송신 버퍼(engine.io가 아직 못 넘긴 글자 수)가 4MB를 넘으면 그 탭을 `c:<id>:behind` room에 넣고 `change`·`log`를 보내지 않는다. 서버 메모리가 회선 속도에 끌려 끝없이 늘지 않게 하려는 것. 2초 쉰 뒤 0.5초마다 버퍼가 비었는지 보고, 비면 room에서 빼고 `status {resync: true, skipped: n}`(+ 로그 구독 중이면 `log:backlog`)를 그 탭에만 보낸다. 탭은 보이는 범위를 다시 받고, Changes 탭에 건너뛴 수를 띄운다. 브라우저는 JS가 바빠도 소켓을 계속 읽으므로, 이게 걸리는 건 주로 회선이 느릴 때(원격·모바일)다.
| server→web | `monitor:sample`, `monitor:backlog` | `MonitorTick` / `MonitorSnapshot` (10초) | 모니터 room |
| server→web | `monitor:alert` | `MonitorAlert` | 연결 room (모든 탭) |
| server→web | `monitor:backfill` | `BackfillReport` | 모니터 room |
| server→web | `settings`, `connections` | 설정·연결 목록 변경 | 전체 |

### B2 Mongo 명령

| 모듈 | 명령 | 언제 |
|---|---|---|
| `monitor/sampler` | `ping` + `serverStatus`(필요 섹션만 ~4KB) | 10초 틱 |
| `realtime` | `watch()` change stream | 연결을 쓰는 동안 계속 |
| `monitor/slowQueries` | `getLog global` (+ `profile:-1`로 slowms 읽기, 5분 캐시) | 10초 틱 위에서 10/30/60초 (아래), **기본 꺼짐**(설정·카드의 Turn on으로 켬). 1분에 50줄까지만 적고 나머지는 개수만 |
| `monitor/top` | `top` | 10초 틱 (거부되면 5분 뒤 재시도) |
| `monitor/replica` | `replSetGetStatus` `replSetGetConfig` | 10초 틱 |
| `monitor/sizes` | `listDatabases` `listCollections` + 컬렉션마다 `$collStats` | 1시간 + 수동(최소 30초 간격) |
| `monitor/operations` | `$currentOp` `killOp` | 요청 시 |
| `monitor/indexes` | `$indexStats` `$collStats` | 요청 시 |
| `monitor/oplog` | oplog.rs 읽기 + `$collStats` | 요청 시 |
| `monitor/startupWarnings` | `getLog startupWarnings` | 요청 시 |
| `monitor/backfill` | oplog.rs 스캔 + `countDocuments` + `watch` | 사용자가 시작할 때 |
| `monitor/identity` | `hello` `replSetGetConfig` | 클러스터 지문(fingerprint) |
| `db.ts` | `hello` `buildInfo` | 연결할 때 |
| `documentList` (문서 목록) | `estimatedDocumentCount`(쿼리면 `countDocuments`) + `aggregate([$match?, $project 요약 재료])`. 1만 개 넘으면 `$sort _id` + `$skip/$limit` 한 페이지 + 선택 문서 순위 `countDocuments(_id 범위)` | 목록 열 때·페이지·실시간 다시 받기 |
| `routes/read` 등 | `listDatabases` `listCollections` `estimatedDocumentCount` `$collStats` `find` | 탐색할 때 |

### B3 디스크 (`~/.mongolive/`)

| 파일 | 내용 |
|---|---|
| auth.json | 비밀번호 해시·세션 |
| settings.json | Safety 설정 (read-only, 보호 대상) |
| connections.json | 저장된 연결 |
| meta.json | owned OID, 컬렉션 메타데이터 |
| metrics/ | 모니터 기록 (샘플·카운터·rollup). 분 파일 보관 = `minuteHistory` 2·7·14일, 연결당 한도 = `historyBudget` 500MB·1GB·5GB·off — 정리(시 경계·설정 바뀐 다음 1분) 때 넘으면 slow·sizes·alerts → 분 → 시·일 순으로 오래된 것부터 지운다 |

### B4 localStorage

연결별 저장(`connectionStorage`: 북마크·쿼리 히스토리·파이프라인), `preferences`, 최근 연결(`activeConnection`), 사이드바, Changes 탭 숨긴 op, mock 설정, 설정 백업 내보내기/가져오기.

## 2. Execution Schedule — 언제 실행되나

### 서버 (연결 하나당 feed 하나)

feed는 그 연결을 쓰는 탭이 있으면 돌고, 마지막 탭이 떠나고 60초 뒤 멈춘다.

| 작업 | 트리거 | 주기 |
|---|---|---|
| **10초 틱** | feed 시작 | 10초: ping+serverStatus → `monitor:sample` push → metrics/ 기록 → sizes·alerts·transactions tick → slow·top·replica poll(병렬) |
| slow `getLog` | 10초 틱이 차례 확인 | 그 연결의 탭 중 Slow 카드가 보이면 10초 / 보이는 탭이 있으면 30초 / 모두 숨으면 60초 / 설정 off면 안 읽음 |
| change stream | Mongo 이벤트 | 이벤트마다: 밀린 탭 확인 → `change`·`log` push(밀린 탭 제외) → activity·alerts·transactions에 기록 |
| 밀린 탭 따라잡기 확인 | 탭이 밀렸을 때 | 2초 뒤부터 0.5초마다, 버퍼가 비면 resync |
| sizes 자동 측정 | 10초 틱이 시각 확인 | 1시간 |
| 클라이언트 정리 | `db.ts` | 60초마다 확인, 10분 놀면 닫음 |
| 소켓 세션 재확인 | `index.ts` | 60초 |
| TLS 인증서 감시 | `tls.ts` | 60초 |

### 웹

| 화면 | 메서드 | 주기 | 쉬는 조건 |
|---|---|---|---|
| 탐색기 (replica set) | `onLiveChange` push → 보이는 범위 다시 받기 | 묶는 간격(0.15/1.5초), 한 번에 하나 — 받는 중 온 변경은 끝난 뒤 `max(간격, 걸린 시간×2)` 쉬고 한 번에 | — |
| 탐색기 (단독 Mongo) | 보이는 범위 다시 받기 (`usePolling`) | 설정값 | 편집 중·충돌·모달·탭 숨김 |
| Overview | `onMonitor` push + `measureRtt` | 10초 | |
| Collections / Overview | `getActivity` / `getHistory` | 10초 / 60초 | 탭 숨김 |
| TopCard | `getTop` | 10초 | 탭 숨김 |
| SlowQueries | `getSlowQueries` | 10초 / 긴 범위 60초 | 탭 숨김 |
| AlertsCard | `getAlerts` + `onAlert` push | 10초 / 긴 범위 60초 | 탭 숨김 |
| TransactionsCard | `getTransactions` | 10초 / 긴 범위 60초 | 탭 숨김 |
| ServerTab | `getReplica` / `getOplog`·`getStartupWarnings` | 10초 / 60초 | 탭 숨김 |
| StorageCard | `getSizes` | 60초 (측정 중 2초) | 탭 숨김 |
| OperationsTab | `getOperations` | **2초** | 탭 숨김 |
| IndexesCard | `getIndexes` | 열 때 | |
| BackfillBanner | `onBackfill` push + `getBackfill` | push | |
| 토스트 | `onAlert` push (page.tsx) | push | |
| 날짜로 찾기 (C2) | `getHistory`·`getSlowQueries`·`getSizes`·`getAlerts` (`from`·`to`) | to가 지금이면 긴 범위처럼 60초, 지난 구간이면 **한 번만** (바뀔 게 없다) · Top·Transactions·Replica lag은 안 부른다 | 탭 숨김 |

## 3. Data Flow Matrix — 데이터가 어디서 태어나 어디로 가나

| # | 원천 (Mongo) | 서버 가공 | 전달 | 소비자 (web) |
|---|---|---|---|---|
| D1 | `serverStatus` 10초 | sampler → rates·gauges | `monitor:sample` push + metrics/ | Overview 차트 |
| D2 | metrics/ 파일 | historyRead | `getHistory` `getHistoryInfo` | Overview 긴 범위, 설정 창 |
| D3 | change stream | realtime feed | `change` push | 탐색기 열, 집계 결과 |
| D3 | 〃 | 〃 | `log` push | Changes 탭 (TXN 묶음 포함) |
| D3 | 〃 | activity.record | `getActivity` | Collections·Overview |
| D3 | 〃 | alerts.record | `monitor:alert` push + `getAlerts` | 토스트, AlertsCard |
| D3 | 〃 | transactions.record | `getTransactions` | TransactionsCard |
| D4 | `getLog` 10/30/60초 | slowQueries | `getSlowQueries` | SlowQueries |
| D5 | `top` 10초 | top | `getTop` | TopCard |
| D6 | `replSetGetStatus` 10초 | replica | `getReplica` | ServerTab 멤버·lag |
| D7 | `$collStats` 1시간 | sizes | `getSizes` | StorageCard |
| D8 | oplog.rs 스캔 | backfill → metrics/ 채움 | `monitor:backfill` push | BackfillBanner, D2 |
| D9 | `$currentOp` 요청 시 | operations | `getOperations` | OperationsTab |
| D10 | `$indexStats` 요청 시 | indexes | `getIndexes` | IndexesCard |
| D11 | oplog.rs 요청 시 | oplog | `getOplog` | ServerTab Oplog 창 |
| D12 | `getLog` 요청 시 | startupWarnings | `getStartupWarnings` | ServerTab 경고 |
| D13 | `explain` 요청 시 | explain | `explainQuery` | 쿼리 바 |
| D14 | `find`/`aggregate` 요청 시 | read·aggregate | `getDocuments` `aggregate` | 탐색기, 집계 |

## 4. Resource & Load Matrix — 얼마나 비싼가

| 작업 | Mongo 부하 | 서버 메모리·디스크 | 빈도 | 종합 |
|---|---|---|---|---|
| ping + serverStatus | 하 (~4KB) | 하 | 10초 | 하 |
| change stream | 하~중 (쓰기량 비례) | 중 (로그 backlog, lag 1000개, 송신 버퍼 탭당 4MB까지 + 보내는 중인 한 묶음) | 상시 | 중 |
| slow (`getLog`) | 중 (한 번에 버퍼 전체 0.2~1MB) | 중 (1시간 보관, 파일은 1분 50줄 상한 → 하루 최대 약 360MB) | 기본 off. 켜면 대부분 30초, 카드 볼 때 10초, 숨으면 60초 | 중 — 10초 고정일 때의 약 1/3 |
| top / replica | 하 | 하~중 (1시간 보관) | 10초 | 하 |
| metrics/ 기록 | — | 디스크 쓰기 (분 줄 ~1KB → 하루 ~1.5MB, 한도 기본 1GB) | 10초, 정리는 1시간마다 폴더 stat | 하 (SD카드면 주의) |
| **sizes** | **상** (컬렉션 수 비례) | 하 | 1시간 + 수동 | 드물지만 무거움 |
| **operations** `$currentOp` | 중 | 하 | **2초** (탭 열려 있을 때) | 중 — 가장 잦음 |
| indexes / oplog / startup | 중 / 하~중 / 하 | 하 | 요청 시·60초 | 하 |
| **backfill** | **상** (oplog 전체 스캔) | 중 | 수동 | 일시적으로 상 |
| 단독 Mongo 폴링 | 중 (보이는 find 재실행) | — | 설정값 | 중 |
| 문서 목록 ≤1만 개 | 중 (Mongo가 전체를 읽지만 보내는 건 문서당 요약 재료 ~수백 B) | 하 (요약만, 최대 1만 개) | 열 때·실시간 | 중 |
| 문서 목록 >1만 개 | 하~중 (`_id` 인덱스로 한 페이지. 먼 페이지는 skip 비례, 선택 문서 순위 세기는 순위 비례) | 하 (한 페이지) | 열 때·실시간 | 하~중 — 글자 검색·제목/필드 정렬은 꺼짐(쿼리 바로 좁힌다) |
| 웹 모니터 폴링 | (서버 메모리만 읽음) | — | 10초 요청 5~6개 | 하 |

## 5. 파이프라인

### 공유 — 원천 하나를 여럿이 쓴다 (서버에서 이미 잘 묶여 있음)

| 파이프라인 | 원천 | 소비자 |
|---|---|---|
| **P1 10초 틱** | ping + serverStatus + getLog/profile + top + replSetGetStatus | Overview, metrics/, slow, top, replica, sizes·alerts·transactions tick |
| **P2 change stream feed** | `watch()` 하나 | 탐색기 live, 로그, activity, alerts, transactions |
| **P3 metrics/ 파일** | P1·P8 기록 | history, 긴 범위 조회 |

### 독립 — 요청할 때만, 혼자 쓴다

operations, indexes, oplog, startup warnings, explain, diagnostics, find/aggregate, mutate, backfill(사용자 시작).

### 발견 — 중복과 끊긴 곳

1. **웹 폴링 루프 복붙 8곳.** `setTimeout` + `document.hidden` + `visibilitychange` 패턴이 TopCard, SlowQueries, AlertsCard, TransactionsCard, StorageCard, OperationsTab, ServerTab, useActivity에 각각 있다. `usePolling` 훅이 이미 있는데 탐색기만 쓴다.
2. **서버는 10초 틱 한 번, 웹은 카드마다 10초 타이머.** 서버가 P1에서 한 번에 계산해 메모리에 두는데, 웹 카드 5~6개가 각자 시계로 따로 묻는다. 틱과 어긋나서 최대 10초 늦게 보이고 요청 수도 늘어난다. 대안: 틱 push를 받을 때 카드가 읽게 한다.
3. **주기 상수가 양쪽에 따로.** 서버 `SAMPLE_INTERVAL_MS = 10_000`, 웹은 `POLL_MS = 10_000`이 6곳에 하드코딩. shared로 하나만 두면 된다.
4. **mock은 모니터에서 스텁만.** `DataSource` 계약과 mock 구현은 있다. 그런데 모니터 메서드 22개가 전부 `null`(=지원 안 함)을 돌려준다. 그래서 데모에선 모니터가 비고, 모니터 UI는 실제 Mongo e2e로만 확인할 수 있었다.
5. **경로 문자열이 서버·웹에 따로.** `DataSource`는 web 안에 있고 서버 라우트와 컴파일 타임 연결이 없다. 한쪽 경로가 바뀌면 다른 쪽에서 런타임에야 알게 된다.
6. **집계 로직의 위치.** alerts·activity·transactions·top 같은 "기록 → report" 로직은 서버 모듈에 있다. 순수 함수 부분을 shared로 빼면 mock이 가짜 change·sample만 흘려 넣어도 같은 로직으로 진짜 같은 카드가 나온다. (분리 가능한지는 확인 필요)

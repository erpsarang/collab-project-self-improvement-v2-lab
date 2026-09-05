# collab-project-self-improvement-v2-lab
LOOP + GRAPH + Self-Improvement V2 연구를 위한 실험 저장소

## 실행

Node.js 20 이상과 `sqlite3` 명령줄 도구가 필요합니다.

```bash
npm install
npm start
```

서버는 기본적으로 `http://localhost:3000`에서 실행되며 `PORT` 환경 변수로 포트를 변경할 수 있습니다.

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Project와 그 하위 Task는 SQLite의 `data/projects.sqlite`에 저장됩니다. 저장 경로는
`PROJECT_DB_PATH` 환경 변수로 변경할 수 있고, 서버를 재시작해도 Project와 Task를 다시 조회할 수 있습니다.

V2-0에서는 `PROJECT_DB_PATH`에 plain filesystem path만 지원합니다. 예를 들어
`data/projects.sqlite`, `./data/projects.sqlite`, `/var/lib/app/projects.sqlite`, `-projects.sqlite`는 지원합니다.

SQLite `file:` URI는 지원하지 않습니다. `file:projects.sqlite`, `file:nested/projects.sqlite?mode=rwc`,
`file::memory:`, `file:memdb?mode=memory` 등 `file:`로 시작하는 값은 서버 시작 시 명확한 설정 오류로 즉시 거부합니다.
빈 경로와 `:memory:`도 connection-scoped database가 될 수 있으므로 지원하지 않습니다.

```bash
curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"첫 프로젝트"}'
# {"id":"...","name":"첫 프로젝트"}

curl http://localhost:3000/projects/<projectId>

curl -X POST http://localhost:3000/projects/<projectId>/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"첫 번째 작업"}'
# {"id":"...","projectId":"...","title":"첫 번째 작업","status":"TODO"}

curl http://localhost:3000/projects/<projectId>/tasks
```

Task는 `id`, `projectId`, `title`, `status`를 가지며 새 Task의 기본 `status`는 `TODO`입니다.
존재하지 않는 Project에는 Task를 생성하거나 조회할 수 없습니다.

## One-shot Autonomous Run

V2-1에서는 Candidate 하나를 사람의 중간 승인 없이 제한된 GRAPH로 끝까지 처리하는 최소 자율 실행 모델을 실험합니다.

```text
PLAN
  ↓
IMPLEMENT
  ↓
VERIFY
  ↓
PUBLISH
  ↓
VERIFY(published HEAD)
  ↓
SEMANTIC_REVIEW
  ├─ PASS → MERGE_READY
  └─ FINDING → FIX → VERIFY → PUBLISH → VERIFY(published HEAD) → SEMANTIC_REVIEW
```

`AutonomousRunService`는 실행 환경과 분리된 GRAPH 엔진입니다. 실제 Codex 실행, 테스트, GitHub publish,
Semantic Review 같은 외부 동작은 `AutonomousRunActions`로 주입합니다. Fix Loop는
`MAX_FIX_ATTEMPTS = 2`로 제한되며, 성공하지 못한 Run은 반드시 `STOPPED(reason)`으로 끝납니다.

`PUBLISH`가 반환한 `publishedHeadSha`는 Semantic Review 전에 반드시 다시 verification 대상이 됩니다.
따라서 task-local에서 검증한 artifact와 실제 GitHub published artifact가 달라질 경우에도,
검증되지 않은 published HEAD가 `MERGE_READY`로 진행할 수 없습니다.

Trusted 영역은 `test/`, `tests/`, `.github/`, `package.json`, `package-lock.json`, `tsconfig.json`,
전체 `scripts/`뿐 아니라 이 저장소의 co-located test 규칙인 `src/**/*.test.*`, `src/**/*.spec.*`도
포함합니다. 자동 Implement/Fix가 이 영역을 변경하면 Run은 즉시 중단됩니다.

`PUBLISH`는 `publishedHeadSha`와 함께 published artifact의 `changedPaths`를 반환해야 합니다.
서비스는 이 경로들이 Implement/Fix가 선언한 변경 경로에 포함되는지 확인하며, trusted path 또는
선언되지 않은 path가 있으면 published-HEAD verification과 Semantic Review 전에 중단합니다.

주요 Stop Policy는 verification 실행 불가, 반복 finding, no-op fix, trusted 영역 변경,
published HEAD와 review SHA 불일치, fix budget 소진, 자동화 예외입니다.

`MERGE_READY`는 자동 Merge를 뜻하지 않습니다. 최종 Merge는 Human Approval 경계로 유지합니다.
각 Run은 Candidate Issue, Run ID, base SHA, published HEAD SHA, fix attempt, verification/review 결과,
상태 이력과 최종 상태를 provenance로 보존합니다.

## 검증

```bash
npm test
npm run typecheck
```

## 구조

- `src/api`: HTTP 요청과 응답 처리
- `src/service`: Project/Task 애플리케이션 동작과 business rule 및 Autonomous Run GRAPH 조율
- `src/repository`: 데이터 저장소 접근 경계와 SQLite 기반 Project/Task 저장소
- `src/domain`: Project/Task 도메인 타입과 Autonomous Run 상태/provenance 모델

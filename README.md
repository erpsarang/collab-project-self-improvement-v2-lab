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

Project는 서버가 식별자를 생성하며 SQLite의 `data/projects.sqlite`에 저장됩니다. 저장 경로는
`PROJECT_DB_PATH` 환경 변수로 변경할 수 있고, 서버를 재시작해도 Project를 다시 조회할 수 있습니다.

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

curl http://localhost:3000/projects/<id>
```

## 검증

```bash
npm test
npm run typecheck
```

## 구조

- `src/api`: HTTP 요청과 응답 처리
- `src/service`: 애플리케이션 동작 조율
- `src/repository`: 데이터 저장소 접근 경계와 SQLite 기반 Project 저장소
- `src/domain`: 도메인 타입과 규칙

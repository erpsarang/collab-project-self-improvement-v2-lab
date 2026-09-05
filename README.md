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

# V2-0-3 SQLite Run History

## 목적

V2-0-3에서는 Project 저장소를 SQLite 기반으로 전환하는 과정에서 여러 번의 Semantic Review, bounded Fix Loop, STOP, Run Restart, Human Decision, 정책 단순화를 실제로 경험했다.

이 문서는 해당 실험을 하나의 실행 계보(run lineage)로 기록한다.

---

## 전체 흐름

```text
Issue #5
→ PR #6 / Run A
→ STOPPED

Issue #7
→ PR #8 / Run B
→ STOPPED

Issue #9
→ PR #10 / Run C
→ STOPPED

Issue #11
→ PR #12 / Run D
→ Semantic Review PASS
→ Human Merge
→ 완료
```

---

## Run A — PR #6

### 목표

Project Repository를 in-memory에서 SQLite로 교체한다.

### 결과

SQLite persistence 구현 자체는 진행됐지만, Semantic Review에서 반복적으로 새로운 edge case가 발견되었다.

주요 finding:

- SQL을 command-line argument로 전달할 때 OS argument limit 문제
- NUL/control character 데이터 보존 문제
- sqlite3 출력 buffer 문제
- Unicode surrogate 처리 문제
- `-`로 시작하는 database path가 CLI option으로 해석될 수 있는 문제

### GRAPH 상태

`STOPPED(MAX_FIX_ATTEMPTS_EXCEEDED)`

Human Override를 한 차례 사용했지만 새로운 finding이 다시 발생했다.

---

## Run B — PR #8

### 목표

PR #6의 구현을 이어받아 `-`로 시작하는 database path 문제를 해결한다.

### 추가 개선

- `sqlite3` 호출에 `--` delimiter 적용
- async child process 전환
- SQLite busy timeout 적용
- lock contention 처리

### 새로운 finding

`PROJECT_DB_PATH=:memory:` 사용 시 operation마다 새로운 SQLite connection이 생성되어 table이 유지되지 않는 문제가 발견되었다.

### GRAPH 상태

`STOPPED(MAX_FIX_ATTEMPTS_EXCEEDED)`

---

## Run C — PR #10

### 목표

connection-scoped SQLite path를 안전하게 처리한다.

### 개선

- `:memory:` 거부
- 일부 SQLite `file:` URI의 memory mode 판별
- repeated `mode` parameter 처리
- URI 기반 filesystem parent path 처리

### 문제

SQLite URI semantics를 부분적으로 구현하면서 새로운 parser edge case가 계속 발생했다.

최종 finding 예:

`file:foo%3Fbar?mode=memory`

percent-decoding과 query delimiter 분석 순서에 따라 실제 SQLite URI semantics와 구현 결과가 달라질 수 있었다.

### GRAPH 상태

`STOPPED(MAX_FIX_ATTEMPTS_EXCEEDED)`

### Human Decision

더 이상 SQLite URI parser를 확장하지 않고 지원 범위를 줄이기로 결정했다.

---

## Run D — PR #12

### 정책 변경

V2-0에서는:

- plain filesystem path만 지원
- `file:` SQLite URI는 모두 거부
- `:memory:`도 지원하지 않음

즉 복잡한 SQLite URI compatibility 자체를 범위 밖으로 이동했다.

### 결과

Fresh Semantic Review:

`PASS`

최종 Merge는 사람이 직접 수행했다.

### GRAPH 상태

`PASS → HUMAN_MERGE → COMPLETED`

---

# GitHub 상태와 GRAPH 상태의 차이

중요한 발견 중 하나는 GitHub의 PR 상태와 우리 방법론의 Run 상태가 동일하지 않다는 점이다.

PR #6, #8, #10은 방법론적으로는 각각:

`STOPPED`

상태였다.

그러나 PR #12가 이전 PR들의 commit lineage를 모두 포함한 상태로 main에 Merge되면서 GitHub에서는 이전 PR들도 최종적으로 `merged=true` 상태가 되었다.

따라서 다음 둘은 반드시 분리해서 기록해야 한다.

## GitHub State

예:

- open
- closed
- merged

## GRAPH Run State

예:

- RUNNING
- PASS
- STOPPED
- HUMAN_DECISION
- COMPLETED

GitHub에서 `merged=true`라고 해서 해당 Run이 방법론적으로 성공한 Run이었다는 뜻은 아니다.

---

# 이번 실험에서 확인한 정책

## 1. Fix Loop는 유한해야 한다

`MAX_FIX_ATTEMPTS = 2`

Fix를 무한 반복하지 않는다.

## 2. STOP은 실패가 아니라 정상 종료 상태다

STOP은 다음을 의미한다.

> 더 이상 AI가 자동으로 진행해서는 안 된다.

## 3. STOP 이후에는 Human Decision이 필요하다

가능한 Human Decision:

- 새로운 Run으로 재시작
- 요구사항 축소
- 지원 범위 축소
- architecture 변경
- Human Override
- 작업 포기

## 4. capability narrowing도 정상적인 해결 전략이다

이번 SQLite 실험에서는 SQLite URI semantics 전체를 구현하려는 시도가 V2-0 목적에 비해 지나치게 복잡해졌다.

따라서 `더 많이 구현` 대신 `지원 범위를 줄임`을 선택했다.

이 역시 정당한 engineering decision이다.

## 5. IMPLEMENT와 PUBLISH는 다른 단계다

Codex task-local 환경에서 구현과 테스트가 성공해도 GitHub에 branch/PR이 생성되지 않을 수 있었다.

따라서:

`IMPLEMENT 성공 ≠ PUBLISH 성공`

이다.

## 6. task-local SHA와 published HEAD는 다를 수 있다

Semantic Review는 반드시 GitHub의 현재 published HEAD를 기준으로 수행해야 한다.

## 7. reconstructed artifact는 별도 검증 대상이다

Codex task-local artifact를 직접 publish하지 못하고 orchestrator가 GitHub에서 재구성한 경우 task-local 테스트 PASS를 published artifact 테스트 PASS로 간주하면 안 된다.

## 8. Semantic Review는 independent verification 역할을 한다

기능 테스트가 모두 PASS해도 performance, concurrency, path semantics, runtime behavior 같은 문제가 Semantic Review에서 발견될 수 있었다.

## 9. 최종 Merge는 Human Approval 경계다

이번 실험에서 최종 Merge는 자동화하지 않았다.

AI가 `IMPLEMENT → VERIFY → REVIEW → FIX`까지 진행하더라도 최종 Merge는 사람이 결정했다.

---

# 최종 실행 모델

이번 실험에서 실제로 확인된 V2 실행 모델은 다음과 같다.

```text
PLAN
  ↓
IMPLEMENT
  ↓
VERIFY
  ↓
PUBLISH
  ↓
SEMANTIC REVIEW
  ↓
┌──────────── PASS ─────────────┐
│                               ↓
│                        HUMAN MERGE
│                               ↓
│                           COMPLETED
│
└─ FINDING
      ↓
     FIX
      ↓
    VERIFY
      ↓
    PUBLISH
      ↓
 SEMANTIC REVIEW
      ↓
 Fix Budget 초과
      ↓
    STOPPED
      ↓
 HUMAN DECISION
      ↓
 NEW RUN / POLICY CHANGE
```

---

# 결론

V2-0-3은 단순한 SQLite 구현 실험이 아니었다.

다음 방법론 요소를 실제 GitHub + Codex Cloud 환경에서 검증했다.

- bounded Fix Loop
- Stop Policy
- Human Decision
- Run Restart
- Provenance
- IMPLEMENT / PUBLISH 분리
- task-local / published artifact 분리
- independent Semantic Review
- capability narrowing
- Human Merge boundary
- GitHub State와 GRAPH State의 분리

특히 중요한 결론은 다음이다.

> Self-Improvement 시스템의 목표는 AI가 끝없이 고치는 것이 아니라, 스스로 진행할 수 있는 범위 안에서 진행하고, 경계를 넘으면 정확하게 STOP한 뒤, 다음 의사결정을 사람에게 넘기는 것이다.

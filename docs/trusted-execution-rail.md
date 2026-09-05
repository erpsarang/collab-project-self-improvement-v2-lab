# Trusted Execution Rail — Bootstrap Boundary

이 문서는 V2-1-5의 **ONE-TIME TRUSTED BOOTSTRAP**과 bootstrap 이후의 정상 Self-Improvement Runtime 경계를 정의한다.

## 경계

Bootstrap은 Rail이 존재하기 전에 외부 신뢰를 최초로 세우는 1회성 단계다. 이 PR은 Human/Trusted Operator가 만들고 검토하며, **Merge는 Human만 수행한다.** Bootstrap 완료 이후 정상 run에서 Human이 branch sync, PR 생성, publish retry, graph continuation을 수행하면 autonomous success로 간주하지 않는다.

## Runtime trust model

| 영역 | 권한 | 역할 |
|---|---|---|
| `approve` | 없음 | `trusted-rail-approval` environment의 Human 시작 승인 |
| `implement` / `fix-*` | `contents: read` | Codex가 workspace만 수정. publish credential 없음 |
| `publish-*` | `contents: write`, `pull-requests: write` | immutable artifact 검증 후 GitHub API publish |
| `verify-*` | `contents: read` | exact `publishedHeadSha` checkout, artifact/test/typecheck 검증 |
| `semantic-*` | `contents: read` | verified SHA만 semantic review |
| `terminal-state` | 없음 | `MERGE_READY` 또는 `STOPPED(reason)` 결정 |

## Required one-time configuration

1. GitHub Environment `trusted-rail-approval`을 만들고 required reviewer를 지정한다.
2. Repository Actions secret `CODEX_API_KEY`를 등록한다.
3. Workflow `GITHUB_TOKEN`이 `contents: write`, `pull-requests: write`를 사용할 수 있도록 repository Actions 설정을 허용한다.
4. `main`은 direct/force update를 허용하지 않고 최종 Merge를 Human 경계로 유지한다.

`CODEX_API_KEY`는 Codex 실행 job에만 전달한다. publish job은 OpenAI key를 받지 않고 job-scoped `GITHUB_TOKEN`만 사용한다. 반대로 Codex job에는 publish token을 전달하지 않는다.

## Immutable artifact

Codex 실행 후 **trusted base에서 미리 빌드된 artifact builder**가 다음을 생성한다.

- exact `rootBaseSha`와 iteration `parentSha`
- issue/run identity
- target branch와 expected previous HEAD
- 정렬된 declared changed paths
- 파일별 operation, complete base64 content, SHA-256
- 전체 canonical artifact SHA-256 digest

정상 Runtime artifact는 `.github/`, `package*.json`, `scripts/`, `src/trusted-rail/`, 이 문서를 수정할 수 없다. Rail 자체의 변경은 별도 Human-controlled trust boundary에서 다룬다.

## Bounded loop

- `MAX_FIX_ATTEMPTS = 2`
- `MAX_PUBLISH_RECOVERY_ATTEMPTS = 2`

Semantic Review finding이 있으면 최대 두 번만 FIX → PUBLISH → VERIFY → REVIEW를 반복한다. 두 번째 fix 이후에도 finding이 남으면 `STOPPED(FIX_BUDGET_EXHAUSTED)`다. Auto Merge는 존재하지 않는다.

## Success invariant

초기 environment approval 이후 최종 `MERGE_READY` 또는 `STOPPED(reason)`에 도달할 때까지 정상 진행을 위해 Human 동작을 요구하지 않는다. 최종 PR Merge만 Human이 수행한다.

# Trusted Execution Rail — Bootstrap Boundary

이 문서는 V2-1-5의 **ONE-TIME TRUSTED BOOTSTRAP**과 bootstrap 이후의 정상 Self-Improvement Runtime 경계를 정의한다.

## 경계

Bootstrap은 Rail이 존재하기 전에 외부 신뢰를 최초로 세우는 1회성 단계다. 이 PR은 Human/Trusted Operator가 만들고 검토하며, **Merge는 Human만 수행한다.** Bootstrap 완료 이후 정상 run에서 Human이 branch sync, PR 생성, publish retry, graph continuation을 수행하면 autonomous success로 간주하지 않는다.

## Runtime trust model

| 영역 | 권한 | 역할 |
|---|---|---|
| `authorize_start` | `contents: read`, `issues: read`, `pull-requests: read` | 정확한 `SI-승인` label event actor의 repository permission과 fresh-run 조건을 검증하고 event-time `main` SHA를 freeze |
| `implement_or_fix` | `contents: read`, `issues: read` | Codex가 workspace만 수정하고 untrusted patch만 생성. publish credential 없음 |
| `seal_artifact` | `contents: read` | approved root의 trusted tooling으로 candidate patch를 별도 workspace에 적용하고 immutable artifact를 봉인 |
| `publish` | `contents: write`, `pull-requests: write` | trusted provenance와 sealed artifact 검증 후 GitHub API publish |
| `verify_published` | `contents: read` | exact `publishedHeadSha` checkout, artifact/test/typecheck 검증 |
| `semantic_review` | `contents: read` | verified SHA만 read-only semantic review |
| `terminal_state` | 없음 | `MERGE_READY` 또는 `STOPPED(reason)` 결정 |

## Required one-time configuration

1. Repository Actions secret `CODEX_API_KEY`를 등록한다.
2. Workflow `GITHUB_TOKEN`이 `contents: write`, `pull-requests: write`를 사용할 수 있도록 repository Actions 설정을 허용한다.
3. `main`은 direct/force update를 허용하지 않고 최종 Merge를 Human 경계로 유지한다.

`CODEX_API_KEY`는 Codex 실행 job에만 전달한다. publish job은 OpenAI key를 받지 않고 job-scoped `GITHUB_TOKEN`만 사용한다. 반대로 Codex job에는 publish token을 전달하지 않는다.

## Candidate patch와 trusted sealing

Codex가 실행되는 workspace는 신뢰하지 않는다. Codex job은 source 변경을 **untrusted binary patch**로만 내보낸다. 그 workspace의 `dist/`, artifact builder, manifest 또는 digest는 publish 근거로 사용하지 않는다.

별도 `seal_artifact` job은 다음 순서로 artifact를 만든다.

1. `rootBaseSha`에서 trusted tooling을 별도 디렉터리에 checkout하고 build한다.
2. `parentSha`를 별도 candidate workspace에 checkout한다.
3. untrusted patch를 candidate workspace에 적용하되 candidate code는 실행하지 않는다.
4. trusted tooling의 builder를 candidate workspace를 대상으로 실행한다.
5. repository, base/root SHA, parent SHA, target branch, expected HEAD, issue/run identity를 trusted workflow input에서 주입한다.
6. 정렬된 changed paths, 파일별 complete base64 content/SHA-256, canonical artifact digest를 생성한다.
7. publish job은 이 sealed artifact만 받으며 provenance를 trusted workflow inputs와 다시 대조한다.

정상 Runtime artifact는 `.github`/`.github/**`, `scripts`/`scripts/**`, `src/trusted-rail`/`src/trusted-rail/**`, `.trusted-rail`/`.trusted-rail/**`, `package.json`, `package-lock.json`, `tsconfig.json`, 이 문서를 수정할 수 없다. Rail 자체의 변경은 별도 Human-controlled trust boundary에서 다룬다.

## Branch update race와 REST API 한계

GitHub REST ref update API는 mutation 요청에 `expected old SHA`를 함께 전달하는 true compare-and-swap 기능을 제공하지 않는다. 따라서 외부 writer가 **마지막 HEAD 확인과 ref mutation 사이**에 branch를 움직이는 매우 작은 race window를 API 수준에서 완전히 제거할 수 없다.

이 Rail은 그 한계를 숨기지 않고 다음으로 최소화한다.

- concurrency key를 `target_branch` 기준으로 설정해 동일 Rail branch의 실행을 직렬화한다.
- publish 시작 시 expected HEAD를 검증하고, commit 준비 후 ref mutation 직전에 즉시 다시 검증한다.
- ref create/update 요청은 재시도하지 않는다.
- update는 `force: false`만 사용한다.
- mutation 직후 exact branch HEAD가 생성한 commit SHA와 같은지 다시 검증한다.
- mismatch/409/422는 `STOPPED(TARGET_HEAD_MOVED)`로 드러낸다.

외부 writer와의 마지막 순간 race 자체는 알려진 trust limitation으로 남는다.

## Single Human start approval

정상 production start는 Issue에 정확한 `SI-승인` label을 붙이는 `issues:labeled` event뿐이다. 수동 `workflow_dispatch`와 protected Environment 승인은 사용하지 않는다. Label event의 `github.actor`에 대해 GitHub repository permission API가 반환한 `write`, `maintain`, `admin`만 허용하며, Issue 본문이나 임의 문자열은 신뢰하지 않는다.

승인 job은 Issue 번호에서 `self-improvement/<issue_number>`를 계산하고, label webhook에 기록된 event-time default-branch `github.sha`를 exact root base SHA로 freeze한다. Rail 시작 직전에 현재 `main` ref가 이 SHA와 다르면 `STOPPED(MAIN_MOVED_SINCE_APPROVAL)`로 종료한다. 승인 label만 Issue별 non-cancelling concurrency를 공유하고 다른 label은 run별 group으로 격리한다. 기존 target branch, 같은 head의 open PR, 두 번째 **trusted** `SI-승인` event를 각각 bounded `STOPPED(...)`로 처리하며, 권한 없는 actor의 label event는 정상 승인 기회를 소모하지 않는다.

Workflow summary에는 승인 Issue, label, actor, event/run identity, frozen SHA, target branch와 authorization decision을 기록한다. 권한 부족이나 collision은 Codex 및 publish job 전에 종료된다.

## Semantic Review invariant

Semantic Review 결과는 다음 양방향 규칙을 만족해야 한다.

- `PASS` → `findings.length === 0`
- `FINDING` → `findings.length > 0`

모순된 결과는 `MERGE_READY`로 진행하지 않고 `STOPPED(SEMANTIC_REVIEW_FAILED)`로 종료한다.

## Bounded loop

- `MAX_FIX_ATTEMPTS = 2`
- `MAX_PUBLISH_RECOVERY_ATTEMPTS = 2`

Semantic Review finding이 있으면 최대 두 번만 FIX → SEAL → PUBLISH → VERIFY → REVIEW를 반복한다. 두 번째 fix 이후에도 finding이 남으면 `STOPPED(FIX_BUDGET_EXHAUSTED)`다. Auto Merge는 존재하지 않는다.

## Success invariant

Human이 `SI-승인` label을 한 번 붙인 뒤 최종 `MERGE_READY` 또는 `STOPPED(reason)`에 도달할 때까지 정상 진행을 위해 다른 Human 동작을 요구하지 않는다. 최종 PR Merge만 Human이 수행한다.

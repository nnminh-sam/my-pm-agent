# PMA-M9 acceptance run (T12)

Date: 2026-09-30. Branch `feature/PMA-M9-T12`, run against HEAD `b0c6eff` (T1–T11 merged).

**Result: 87/87 automated checks passed. No bugs found, so this commit has no code changes.**

Three things still need the owner, because they need a real PAT or a real GitHub webhook (see the checklists at the end):
- the real-PAT run;
- setting up the real webhook;
- the Vercel secrets.

## How it was run

The app was a production build (`next build` with Turbopack, then `next start`) of a detached git worktree of HEAD. It ran on `127.0.0.1:47812`. Its environment:
- `PM_STORAGE=fs` with a scratch `PM_DATA_DIR`;
- no `DATABASE_URL` or `JWT_SECRET`, so the auth mode was `open`;
- `GITHUB_TOKEN=fake-token-…` and `GITHUB_WEBHOOK_SECRET=fake-secret-…`;
- `GITHUB_API_URL` pointing at a mock GitHub API on `127.0.0.1:47811`.

The fake secrets were also set during `next build`, so the bundle grep below would catch any inlining.

The run did not touch Neon, GitHub or the owner's `next dev` on port 3000.

**Mock GitHub.** It serves `GET /repos/nnminh-sam/my-pm-agent/pulls/{n}`, `…/pulls/{n}/reviews` and `…/pulls?state=open`, with realistic payloads:
- **PR #1:** open; the body has markdown and `<script>alert(1)</script>`; GitHub milestone "v0.9 GitHub"; requested reviewer carol; reviews alice COMMENTED→APPROVED and bob CHANGES_REQUESTED; assignees nnminh-sam and bob-helper.
- **#2:** draft.
- **#3:** merged.

A control endpoint switches it between the modes `ok`, `503`, `429` (with `x-ratelimit-remaining: 0` and `x-ratelimit-reset`), `hang` (8s), `401`, `404` and `echo` (a 500 whose body quotes the `Authorization` header). It logs every request, so the number of GitHub calls can be asserted.

**Seed.** Created through `src/lib/repo.ts`:
- **AGT:** personal, linked to `github.com/nnminh-sam/my-pm-agent`, with tasks T1…T7.
  - T1 references PR #1.
  - T2 references two PRs, given as a URL (#2) and a short ref (#3).
  - T3…T6 reference #4…#7.
- **CO:** a company project from the start, with repo `acme-corp/company-repo`.
- **EXCO:** a personal project that stored PR `nnminh-sam/other-repo#1` and then became company.

**Driving it.** Everything went over HTTP:
- **Pages:** GET, then assertions on the server-rendered markup.
- **MCP:** `POST /api/mcp` `tools/call`.
- **Webhook:** `POST /api/github/webhook`, HMAC-signed with the fake secret.
- **Server actions:** called exactly as the browser calls them, with the `Next-Action` header and React's reply encoding. This covers `addCommentAction`, `deleteCommentAction` and `retryGithubSync` (Retry now).

The harness is in the session scratchpad and is not committed. `run.mjs` restores the seed on each run, and its exit code is 0 only when every check passes.

## Acceptance criteria

### 1. typecheck, lint, test and build pass, with tests for the listed areas: PASS

The four checks pass on this branch (38 test files, 681 tests). The required tests exist:

| Area | Test file |
|---|---|
| Webhook signature verification | `src/lib/github/webhook.test.ts` |
| PR URL normalization | `src/lib/repo.test.ts` (`normalizePr`) |
| Error → reason classification | `src/lib/github/github.test.ts` (`classifyFailure`, `retryAfterFrom`, redaction) |
| Snapshot decision: fresh / retry_after / fetch / keep-on-failure | `src/lib/github/sync.test.ts`, `src/lib/github/pull.test.ts` |
| Applying webhook payloads | `src/lib/github/webhook.test.ts` |

### 2. A task referencing a my-pm-agent PR shows its overview, and no diff or comments are fetched: PASS (mock); real PAT run is an owner step

`GET /tasks/AGT-M1-T1` returned 200 in 67 ms. The server-rendered markup contains:
- the title;
- the state `open`;
- the milestone `v0.9 GitHub`;
- the branches `main ← feature/pma-m9-t10`;
- the author;
- the assignees `nnminh-sam, bob-helper`;
- the reviewers `alice-reviewer approved`, `bob-helper changes requested` and `carol-reviewer pending`;
- `href="https://github.com/nnminh-sam/my-pm-agent/pull/1"` ("Open in GitHub");
- the body rendered as markdown (`<strong>sync badge</strong>`, a task list, `<code>`);
- "synced just now".

The review text ("SECRET REVIEW TEXT …" in the mock) appears nowhere.

- **Mock log:** exactly 2 calls, `GET /repos/nnminh-sam/my-pm-agent/pulls/1` and `GET …/pulls/1/reviews?per_page=100`, both with the Bearer token. There were no calls to diff, files, commits or comments endpoints.
- **Two PRs:** T2 (draft #2 and merged #3) made 4 calls and rendered `draft` and `merged`.
- **Fresh window:** reopening T1 within 60s made 0 calls.
- **Project page:** `GET /projects/AGT` made 1 call (`/pulls?state=open&per_page=100`) and listed the open PRs, without merged #3.
- **Task lists:** `/milestones/AGT-M1` and `/backlog` made 0 calls. The chips were: `PR #1 · changes requested`, `PR #2 · draft`, `PR #3 · merged`, `PR #7 · merged` and `PR #4 · not synced`.

### 3. GitHub unreachable: PASS

**Injected 503.** T1's last good fetch was backdated 15 minutes. `GET /tasks/AGT-M1-T1` returned 200 in 38 ms and showed:
- the amber badge (`bg-warn-soft text-warn`), "Out of sync · last synced 15m ago";
- the details: "GitHub is unavailable", HTTP 503, GitHub's message "Service Unavailable (mock outage)", the request id, the last attempt, **Retry now** and githubstatus.com;
- the last snapshot, still rendered in full.

Stored `last_error`: `{"reason":"github_down","status":503,"message":"Service Unavailable (mock outage)","request_id":"MOCK:503:1"}`. `get_task` returned `sync: out_of_sync`, `reason: github_down`, the `fetched_at` of the last good fetch, and the message.

**Never-viewed PR.** `GET /tasks/AGT-M1-T3` (#4) returned 200 with:
- the red badge "Never synced";
- "GitHub is unavailable";
- "Open in GitHub", `href="https://github.com/nnminh-sam/my-pm-agent/pull/4"`.

The stored row has `last_error` and no `data` or `fetched_at`.

**Bad base URL.** The mock was stopped, so connections were refused. T1 returned 200 with "Out of sync" and `github_down` (message "fetch failed").

**Project page** during the outage: 200.

**Retry now after recovery.** The `retryGithubSync` server action made 2 calls and returned `sync: synced`.

### 4. A 429 with a reset header sets retry_after, and nothing calls GitHub before it, Retry now included: PASS

**First view.** In mode `429` with the reset 600s ahead, the first view of `/tasks/AGT-M1-T4` (#5) made 2 calls. It stored `retry_after: 2026-09-29T23:41:26.000Z`, which is exactly the `x-ratelimit-reset`, and `last_error.reason: rate_limited`. The page (200) says "Rate-limited until 2026-09-29 23:41 UTC".

**No calls after that.** The mock was then switched back to `ok`, so any call that reached it would have succeeded and shown up. None did:
- the next page view made 0 calls;
- **Retry now**, called over HTTP, returned `reason: rate_limited` with the same `retry_after` and made 0 calls;
- `get_task` showed `retry_after` and made 0 calls.

**Previously good snapshot.** A 429 on the good snapshot of #1 set `retry_after` and kept the data.

### 5. A failed fetch never overwrites a good snapshot: PASS

`data` and `fetched_at` in the stored file were byte-identical before and after each failure: 503 (#1), connection refused (#1), 429 (#1) and 500/echo (#2). Only `last_attempt_at`, `last_error` and `retry_after` changed.

### 6. Webhook: PASS

With no GitHub calls across all deliveries:

| Delivery | Status | Stored result |
|---|---|---|
| Signed `pull_request` `closed`, `merged: true` for #7 (fetched before as `open`) | 204 | `state` changed from `open` to `merged`, `merged_at: 2026-09-29T10:00:00Z`. The task page shows `merged`; the task status stays `todo`. |
| Signed `pull_request_review` `submitted` `approved` by carol-reviewer on #1 | 204 | carol changed from `pending` to `approved`; alice (approved) and bob (changes_requested) were kept. The review text was not stored. |
| Bad signature | 401 | nothing |
| Unsigned | 401 | nothing |
| `ping` | 204 | nothing |
| Unhandled event (`issues`) | 204 | nothing |
| Repo not linked to any project (`someone/unlinked-repo`) | 204 | nothing |
| Company-only repo (`acme-corp/company-repo`) | 204 | nothing |
| Repo of the now-company EXCO project | 204 | nothing |
| Out-of-order older `pull_request` | 204 | ignored; #7 stayed merged |
| Signed `application/x-www-form-urlencoded` body | 400 | nothing |
| `pull_request` for a never-fetched PR | 204 | snapshot created |

### 7. get_task returns each PR's overview and sync without calling GitHub: PASS

`get_task AGT-M1-T1` returns `pull_requests[0]`, made of:
- `ref` and `url`;
- the full `overview`: title, body, state, milestone, 3 reviewers with their states, 2 assignees, author, branches and URL;
- `sync: {sync: "synced", fetched_at, reason: null}`.

It also returns `comments`. For a never-viewed PR it returns `overview: null` and `sync: never`. The mock logged 0 calls.

### 8. PRs from unlinked repos are rejected; company projects refuse PR references and never call GitHub: PASS

- **Unlinked repo:** `update_task AGT-M1-T7 prs:[…someone/unlinked-repo/pull/3]` was rejected: "PR someone/unlinked-repo#3 is in someone/unlinked-repo, which isn't linked to project AGT…".
- **Company task:** `update_task CO-M1-T1 prs:[…#1]` was refused: "CO is a company project, which takes no PR references…".
- **Pages:** `/tasks/CO-M1-T1`, `/projects/CO`, `/tasks/EXCO-M1-T1` and `/projects/EXCO` all returned 200 with no PR section or badge, even though EXCO's task still stores a PR ref.
- **MCP:** `get_task EXCO-M1-T1` has no `pull_requests`.
- **Retry now** on `pr:nnminh-sam/other-repo#1` returned `refusal: company`.
- **Webhook:** covered in criterion 6.

The mock logged 0 calls. The unit tests cover this too (`repo.test.ts` and `pull.test.ts`, company and not_linked).

### 9. Comments are added and deleted in the web UI, added over MCP, returned by get_task, and `<script>` renders as text: PASS

- **Adding in the UI:** `addCommentAction` over HTTP returned `{ok:true}` twice, stored with author `you`.
- **Deleting in the UI:** `deleteCommentAction` returned `{ok:true}` and removed one comment.
- **MCP:** `add_comment` stored a comment with author `agent`.
- **get_task** returns both comments, oldest first.
- **Company task:** it takes comments.
- **Escaping:** the comment `<script>alert('c')</script>` followed by a newline and `second line` renders as `&lt;script&gt;alert(&#x27;c&#x27;)&lt;/script&gt;</span><span><br/>second line`, so it is escaped and the line break is kept.
- **PR body:** its `<script>alert(1)</script>` renders as `&lt;script&gt;alert(1)&lt;/script&gt;`, and the markup has no raw `<script>alert`.
- **Extra probe:** hostile markdown was pushed through the signed webhook. `[x](javascript:…)` became `href=""`, and raw `<img onerror>` and `<a href="javascript:">` were escaped as text. A `javascript:` `html_url` is never used, because links are built from the ref.

### 10. The PAT and webhook secret never appear in client bundles, MCP output or last_error: PASS

`grep -rF` found neither `fake-token-…` nor `fake-secret-…` in any of:
- `.next/static` of the harness build (the client bundle), although both secrets were set during the build;
- all 24 saved page HTMLs;
- the stored snapshots and comments;
- the MCP output of `get_task`, `get_project`, `list_tasks` and `get_overview`;
- the server log.

**Echo mode.** GitHub's error body quoted `Authorization: Bearer fake-token-…`. It was stored and returned as `"upstream error; you sent Authorization: Bearer [redacted]"`, in `last_error`, on the page and in `get_task`.

**Other statuses.** 401 shows "Token invalid or expired" and 404 shows "Repo renamed, deleted or not granted to the token".

### 11. The migration applies on Neon development and the file backend, and db:export / db:import round-trip: not re-run here (covered earlier)

The file backend was exercised throughout this run. The migration and round-trip were done in T1:
- migration 007 was applied on the Neon development branch;
- `src/lib/repo.test.ts` "round-trips: markdown → Postgres → markdown" carries `prs`, snapshots and comments (PGlite);
- `src/lib/migrate.test.ts` covers 007.

This run did not touch Neon, as instructed.

### 12. README and CLAUDE.md cover PAT scopes, webhook setup, the sync badge and comments: T13

These docs are T13. Also add `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and the optional `GITHUB_API_URL` to `.env.example`, which doesn't list them yet.

## Observations (not defects, no change made)

- **`retry_after` is per snapshot key, as the spec's architecture describes.** GitHub's rate limit is per token. So during a rate limit, opening a *different* PR (or the project page) still makes its 1–2 calls, which then get their own 429 and `retry_after`. The call to the key that was rate-limited never repeats. Verified: with #5 rate-limited, viewing T2 called GitHub for #2 and #3. A later option would be a global "token rate-limited until" check, if this ever matters.
- **Raw HTML in a PR body is shown as escaped text, not dropped.** The spec's overview section says "raw HTML stripped". The acceptance criterion ("renders as text") holds, and the page is safe. If literally stripping it is wanted, pass `skipHtml` to `ReactMarkdown` in `Markdown`. That is a product choice, so it was left alone.
- **Badge times are in UTC** ("Rate-limited until 2026-09-29 23:41 UTC"), not the settings timezone (Asia/Ho_Chi_Minh).
- **Comment newlines are stored as CRLF.** A comment added through the web form keeps the browser's form encoding. `CommentText` handles `\r\n`, and MCP comments keep `\n`.

## Owner checklist: real PAT run

1. Create a **fine-grained PAT** at GitHub → Settings → Developer settings → Fine-grained tokens:
   - **Resource owner:** nnminh-sam.
   - **Repository access:** "Only select repositories" → `nnminh-sam/my-pm-agent`. Add any other repo later linked to a personal project.
   - **Repository permissions:** **Pull requests: Read-only** and **Metadata: Read-only** (Metadata is added automatically). Nothing else.
   - **Expiration:** your choice. When it expires, the badge shows "Token invalid or expired".
2. In `.env.local`:
   - add `GITHUB_TOKEN=github_pat_…`;
   - add `GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>` for step 3;
   - leave `GITHUB_API_URL` unset, so the app uses `https://api.github.com`.

   `DATABASE_URL` must be the Neon **development** branch, which has migration 007. Restart `next dev` so it picks up the variables.
3. PMA already links `github.com/nnminh-sam/my-pm-agent`. Set a real PR on a task, e.g. `update_task PMA-M9-T11 prs:["https://github.com/nnminh-sam/my-pm-agent/pull/11"]` (or the task's record editor).
4. Open `http://localhost:3000/tasks/PMA-M9-T11` and check:
   - title, body, the `merged` state with its date, milestone (if the PR has one), reviewers with their states, assignees, "Open in GitHub", and "synced just now";
   - `/milestones/PMA-M9` shows the chip `PR #11 · merged`;
   - `/projects/PMA` lists the open PRs, or none;
   - `get_task PMA-M9-T11` returns `pull_requests[0].overview` and `sync.sync = "synced"`.
5. **Optional outage check:** set `GITHUB_API_URL=http://127.0.0.1:9`, restart, wait more than 60s, and reload. You should see amber "Out of sync" with "GitHub is unavailable" and no page error. Then unset it and restart again.
6. On Vercel, add `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` as **Sensitive** environment variables in Production (and Preview, if used), then redeploy. The production database must have migration 007 **before** this deploy. Pair migrate with deploy, per the milestones-rollout note.

## Owner checklist: real webhook

It needs a **publicly reachable deployment** (the Vercel URL, not localhost) whose database has **migration 007** and whose environment has `GITHUB_WEBHOOK_SECRET` set.

1. Go to GitHub → `nnminh-sam/my-pm-agent` → **Settings → Webhooks → Add webhook**.
2. Fill it in:
   - **Payload URL:** `https://<your-app>.vercel.app/api/github/webhook`. `src/proxy.ts` lets exactly this path through without a session. The HMAC is its auth.
   - **Content type:** `application/json`. A form-encoded body gets a 400.
   - **Secret:** the same value as `GITHUB_WEBHOOK_SECRET` on that deployment.
   - **SSL verification:** enabled.
   - **Events:** "Let me select individual events" → **Pull requests** and **Pull request reviews**. Nothing else is needed; other events get a 204 and are ignored.
   - **Active:** checked.
3. Save. GitHub sends a `ping`. Under Recent Deliveries it should show **204**. A 401 means the secret doesn't match, or `GITHUB_WEBHOOK_SECRET` isn't set on the deployment; the server logs a warning once.
4. Merge or approve a test PR that a task references. The delivery should show 204, and the task page should show `merged` or the reviewer as `approved` straight away, with no GitHub call.
5. GitHub doesn't retry failed deliveries on its own. A missed one is corrected by the next page view after 60s, or by using Redeliver in the webhook's Recent Deliveries.

## Check results (this branch)

`npm run typecheck && npm run lint && npm test && npm run build` → exit 0. Test Files 38 passed (38); Tests 681 passed (681); build compiled successfully.

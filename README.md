# my_pm

A personal project manager built to be driven by AI agents.

- **Projects → milestones → tasks**, each with a readable code (`PMA`, `PMA-M1`, `PMA-M1-T3`), stored in Neon Postgres, or as Markdown files with YAML frontmatter that you can read, diff and edit by hand.
- **A scheduler lays tasks onto your working hours**, following priority, dependencies and deadlines. It re-plans every time an estimate, priority or piece of logged time changes.
- **Every project follows one lifecycle**, from idea to release and learn. A project's playbook adds checks to each stage and names its environments, and `get_next` tells you what to do next across all your projects. See [Lifecycle](#lifecycle).
- **An MCP server** at `/api/mcp` lets Claude Code or any other MCP client break milestones down, estimate, rearrange and log time. The same tools are exposed to in-browser agents through WebMCP.
- **A small web UI** with Schedule, Projects, Backlog, Milestone and Task pages. Copy a code to hand a task to an agent, or edit any project, milestone or task as markdown.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Without `JWT_SECRET` auth is off locally: no login, and `/api/mcp` is open. See [Auth](#auth) to turn it on.

### Storage

| Backend | Picked when | Notes |
| --- | --- | --- |
| Neon Postgres | `PM_STORAGE=postgres`, or `DATABASE_URL` is set and `PM_STORAGE` isn't `fs` | Relational rows (`migrations/`); markdown bodies are `text` columns |
| Markdown files | default locally (`./data`, or `PM_DATA_DIR`) | `PM_STORAGE=fs` forces it |

`get_overview` reports the active backend as `storage`; the Connect page shows it too.

### Neon

Point local dev at your own Neon branch, never `production`:

```bash
neon branches create --name development --parent production
neon connection-string development --pooled          # -> DATABASE_URL (app queries)
neon connection-string development                    # -> DATABASE_URL_UNPOOLED (migrations, scripts)
```

Put both plus `NEON_BRANCH` in `.env.local` (see `.env.example`), then:

```bash
npm run db:smoke                          # select 1 over both URLs
npm run db:migrate                        # apply migrations/*.sql (no-op when up to date)
npm run db:import -- --dry-run            # what would be copied from ./data
npm run db:import                         # ./data → Postgres, then verifies workspace + schedule are identical
npm run db:import -- --replace            # overwrite a non-empty database
npm run db:export -- --to backups/2026-10-01   # Postgres → markdown in the data/ layout (backup / rollback)
```

All scripts use `DATABASE_URL_UNPOOLED`. The import runs in one transaction and carries each parent's numbering counter, so new milestones and tasks continue from the imported numbers. For a periodic backup, schedule `npm run db:export -- --to backups/$(date +%F)` (cron, or a CI job with the secret set); Neon's point-in-time restore covers the rest.

`npm test` runs the repository suite against the file backend and an in-process Postgres (PGlite). To also run it against real Neon, point `TEST_DATABASE_URL` at a disposable branch — **the suite truncates it**:

```bash
neon branches create --name test --parent development --expires-at <tomorrow>
TEST_DATABASE_URL="$(neon connection-string test)" npm test
```

Claude Code started in this folder picks up the server from `.mcp.json`. From anywhere else, add it once:

```bash
claude mcp add --transport http --scope user my-pm http://localhost:3000/api/mcp
```

Then just talk to it:

> Create a project "Website relaunch" with code WEB (due Nov 15) and plan its milestones.
> Break down WEB-M2.
> I spent 2h on WEB-M1-T3 and it's done. What's next today?
> WEB-M1-T2 is bigger than I thought, more like 10h. Replan.

Prompts are also available as slash commands: `/mcp__my-pm__breakdown_project WEB`, `/mcp__my-pm__breakdown_milestone WEB-M1`, `/mcp__my-pm__work_on_task WEB-M1-T3`, `/mcp__my-pm__estimate_tasks`, `/mcp__my-pm__replan`, `/mcp__my-pm__daily_checkin`.

## Data format

A **project** has many **milestones**, and each milestone is broken down into many **tasks**. A task belongs to a project through its milestone.

Every record has two identifiers:

- **`code`**, for people and agents. A project's code is chosen when it's created (2–6 letters or digits, e.g. `WEB`). Milestones are numbered within their project (`WEB-M1`) and tasks within their milestone (`WEB-M1-T3`). Codes are matched case-insensitively.
- **`id`**, a UUID v7 and the primary key. It never changes, so references between records (`project`, `milestone`, `depends_on`) hold ids.

A code changes when the project's code changes (every code in the project follows) or when an item moves to another parent (it takes the next number there). Numbers are never reused: each parent keeps a counter (`last_milestone_number`, `last_task_number`), so an old code can stop resolving but never points at something else. Tools and pages accept either the code or the id.

```
data/
  settings.yaml          # timezone, working hours, days off, estimate buffer
  projects/<id>.md       # code WEB; goal and context in the body
  milestones/<id>.md     # code WEB-M1, `project: <project id>`; spec in the body
  tasks/<id>.md          # code WEB-M1-T3, `milestone: <milestone id>`
  playbooks/<name>@<version>.yaml   # stored playbook versions (see Lifecycle); written once, never changed
```

Files are named by id, so they never need renaming; the code is the second line of the frontmatter.

Priority and deadline flow downwards. A task without its own priority uses its milestone's, then its project's. The earliest deadline among task, milestone and project applies. A project that is `on_hold`, `done` or `cancelled` keeps all of its tasks off the schedule.

```markdown
---
id: 0199c4a2-7f3e-7a10-9c1d-2b5e8f0a4d61
code: WEB
title: Website relaunch
status: active             # planned | active | on_hold | done | cancelled
priority: P1
deadline: 2026-11-15
context: personal          # personal | company (company projects keep only metadata and links)
playbook: WEB@1.0.0        # the pinned playbook version, once adopted (see Lifecycle)
repos: [github.com/acme/web]   # git remotes, normalized; a repo belongs to one project
detectors: [migrations]    # playbook detectors that fired in its repos
created: 2026-09-27
last_milestone_number: 2   # managed by the app: the highest milestone number handed out
---

## Goal
…
```

```markdown
---
id: 0199c4a3-1b20-7c44-8e2f-6d0a9b3c5e17
code: WEB-M1-T3            # managed by the app, from the milestone's code and `number`
number: 3
title: Login form with validation
status: in_progress        # todo | in_progress | blocked | done | cancelled
priority: P1               # P0–P3; omit to inherit from milestone → project
milestone: 0199c4a2-9d51-7b02-a6e3-4f1c7d2e8b90
estimate: 3.25             # hours (PERT mean when a range is given)
estimate_range: [2, 5]     # optimistic, pessimistic
spent: 1.5
deadline: 2026-10-06
not_before: 2026-09-30     # optional: don't schedule earlier
depends_on: [0199c4a3-0a7f-7d19-b2c8-3e6f1a9d4c02]   # task ids
tags: [frontend]
order: 0                   # optional manual rank within a priority
created: 2026-09-27
---

Context and acceptance criteria…

## Log

- 2026-09-27: 1.5h — form skeleton
```

## How scheduling works

`src/lib/scheduler.ts` is a pure function with its own tests (`npm test`). It works like this:

1. Open tasks with an estimate are placed one after another into your working intervals, starting now. Each block is at least `min_block_hours`, and tasks split across breaks and days.
2. Each step picks the best *ready* task, meaning its dependencies are already placed and its `not_before` date has passed. The ranking is priority first (inherited from anything that depends on the task), then in-progress work, then the earliest deadline, then manual `order`, then code (`WEB-M1-T2` before `WEB-M1-T10`).
3. **Deadline repair.** If a task would miss its deadline, the scheduler tries pulling it, and its prerequisites, ahead of the priority order. It keeps the change only if total priority-weighted lateness goes down.
4. Remaining work is `estimate × buffer − spent`. Tasks that are blocked, unestimated or waiting on either are listed with the reason. Tasks larger than `max_task_hours`, or over their estimate, produce warnings.

Estimation is calibrated from your own history. `get_estimation_stats` compares actual time with estimated time, overall and per tag, and suggests a `buffer` once 5 or more tasks are done.

## Lifecycle

Tasks say what's left to build. The lifecycle says where each milestone stands on its way to shipping, and what to do next across projects. `src/lib/lifecycle.ts` is pure and tested, like the scheduler.

- **Stages are fixed:** idea → spec → design → plan → build → verify → release → learn, then done. After learn, a milestone can go through maintain first, when its retro proposed playbook changes.
- **A playbook adds checks to the stages.** A project pins one version (`PMA@1.0.0`), normally its own playbook compiled from shared layers (`sdlc`, `personal`, `company`). A stored version never changes, so pinning an older one rolls back. The seed `sdlc@1.0.0` is `src/lib/playbooks/sdlc.yaml`.
- **Checks are keyed `<stage>.<name>`.** `auto` checks are computed: tasks estimated, small enough, done, time logged, deployed to every environment. `probe` checks come from repo signals such as test runs. `attest` checks are recorded with evidence. A milestone leaves a stage only when that stage's checks are passed, or waived with a reason.
- **Environments come from the playbook, in promotion order** (`dev → prod`). A milestone in release reaches them one at a time. An environment's own checks, such as a rollback plan for prod, come before deploying to it.
- **Detectors add checks when a repo has something.** For example, `migrations/` adds `release.migration_paired` for prod.
- **Company projects keep only metadata and links.** A playbook compiled from the `company` layer is stored without its check, principle or environment text.

A milestone carries its stage, its check results and the environments it has reached:

```markdown
---
code: WEB-M2
status: in_progress        # kept in step with the stage
stage: release
checks:
  spec.accepted:
    status: passed         # passed | failed | waived (a check with no result is open)
    at: 2026-10-01
    note: https://…/spec   # evidence, or a waiver's reason
deployments:
  dev:
    at: 2026-10-20
    ref: a1b2c3d
---
```

`get_next` lists warnings first: a project with no playbook, a playbook with no project rules, or a newer version to adopt. Then it gives one entry per next action (the same step for several milestones is listed once), ranked by deadline risk, priority, later stage first and deadline. Today's scheduled blocks come last.

Playbooks are written and released in the private [playbooks repo](https://github.com/nnminh-sam/playbooks). That repo also holds the `sdlc` Claude Code plugin, which starts each session in a project's repo with a brief (status, next actions, the rules that apply) and adds `/sdlc:next`, `/sdlc:rules`, `/sdlc:status` and `/sdlc:adopt`. Its README is the guide to using all of this, with examples.

To adopt a playbook, store it and then pin it. Store it with `sync_playbook`, or with `POST /api/playbooks` and the compiled playbook as JSON (201 new, 200 already stored, 409 different content under a stored version). Then call `set_playbook_version` with `stages` to place the project's existing milestones.

## MCP tools

| Tool | What it does |
| --- | --- |
| `get_overview` | Today's plan, milestones with progress and projected finish, risks, settings |
| `list_tasks` / `get_task` | Browse tasks with their scheduled slot |
| `create_tasks` | Create many tasks in one call; `ref`s let tasks depend on each other in the same batch |
| `update_task` | Status, priority, estimate or `pert`, deadline, dependencies, order, notes, `prs`; `milestone` moves it |
| `add_comment` | Append a plain-text comment to a task (author `agent`) |
| `log_time` | Add hours worked; `done=true` completes the task |
| `reorder_tasks` | Manual order within a priority |
| `list_projects` / `get_project` / `create_project` / `update_project` | Projects: code, goal, rollup across milestones, on-hold |
| `list_milestones` / `get_milestone` / `create_milestone` / `update_milestone` | Milestones (within a project) and their specs; `project` moves one |
| `get_schedule` | Day-by-day plan (text or JSON) |
| `get_estimation_stats` | Estimate accuracy, overall and per tag |
| `update_settings` | Working hours, days off, buffer and so on |
| `get_next` | Lifecycle warnings and ranked next actions across projects, plus today's blocks |
| `get_lifecycle` | One project: pinned playbook, environments, each milestone's stage, checks and next action |
| `pass_check` / `fail_check` / `waive_check` / `reopen_check` | Record a check's result: evidence, or a waiver's reason |
| `advance_stage` | Next stage once the current stage's checks pass, or back to an earlier stage |
| `record_deployment` | A milestone reached an environment, in promotion order |
| `sync_playbook` / `set_playbook_version` | Store a playbook version, and pin a project to one (adopt, upgrade, roll back) |

### Hand a task to an agent

Every code in the web UI (page headings, task lists) has a copy icon next to it. Paste the bare code, e.g. `WEB-M1-T3`, into an MCP-connected agent: the server instructions tell it to call `get_task`, which returns the task with its milestone spec, project and the status of each dependency, then set it in progress, do the work and `log_time` as it goes. `/mcp__my-pm__work_on_task WEB-M1-T3` spells out the same steps.

## Editing in the web UI

**Edit** on a project, milestone or task page turns it into markdown: the editable fields as YAML frontmatter, the description (a milestone's spec) as the body. **⌘/Ctrl+Enter** saves, **Esc** cancels.

| Record | Editable fields |
| --- | --- |
| Task | `title`, `status`, `priority`, `milestone`, `estimate`, `deadline`, `not_before`, `depends_on`, `tags`, `prs` |
| Milestone | `title`, `status`, `project`, `priority`, `deadline` |
| Project | `code`, `title`, `status`, `priority`, `deadline` |

- References are written as codes (`milestone: WEB-M1`, `depends_on: [WEB-M1-T2]`); unknown codes and dependency cycles are refused.
- Read-only, and refused if added: `id`, a task's or milestone's `code` and `number`, `created`, the numbering counters, and on tasks `estimate_range`/`pert`, `order`, `spent`, `completed` and the log. Time goes through **Log time**.
- Removing a key clears it: `priority` → inherit, `deadline`, `not_before`, and lists become empty. Required fields (`title`, `status`, the parent, a project's `code` and `priority`) and `estimate` can't be removed. A changed `estimate` replaces a three-point range.
- Changing a project's `code` renames its milestones and tasks; moving a task or milestone gives it the next number in its new parent. The page follows to the new URL.
- If the record changed elsewhere (say, an agent updated it) since the editor opened, the save is refused with "changed elsewhere": copy your edits, reload and apply them again.

## GitHub integration

A task can reference pull requests, and my_pm shows each one's **overview**: title, body, state (open, draft, merged, closed), GitHub milestone, branches, author, assignees, and reviewers with their latest state (approved, changes requested, commented, pending). It never shows diffs, files, commits or review text; use `gh` for those. Company projects never contact GitHub: they take no PR references and show no PR section (a PR stored before a project became company is hidden).

### Linking repos and PRs

- **Repos:** link `owner/repo` on the project page (Repositories), or with `update_project` `repos`. Only linked repos of personal projects are ever read.
- **PRs:** set a task's `prs` in the record editor (`prs:` list) or with `update_task`, as a URL or `owner/repo#N` (stored as `owner/repo#N`). The list replaces the old one, and `[]` clears it. It is rejected when the PR's repo isn't linked to the task's project, or the project is a company project.
- **Where it shows:** the task page (overview and sync badge), a chip on task rows (`PR #11 · merged`), the project page (open PRs per linked repo), and `get_task` (`pull_requests`).

### Token (`GITHUB_TOKEN`)

Create a **fine-grained personal access token** at GitHub → Settings → Developer settings:

- **Repository access:** only the linked repos (add each repo you link later).
- **Permissions:** **Pull requests: Read-only** and **Metadata: Read-only**. Nothing else.

Set it as `GITHUB_TOKEN` in `.env.local`, and on Vercel as a **Sensitive** environment variable (Production, and Preview if used), then redeploy. The token stays on the server: it is never sent to the browser or included in MCP output, and error text is redacted before it is stored. Without it, PRs show "Token invalid or expired". `GITHUB_API_URL` is optional (default `https://api.github.com`); point it at a mock to test, or at a dead address (`http://127.0.0.1:9`) to simulate an outage.

### How syncing works

my_pm keeps a **snapshot** per PR (and per linked repo, for the open-PR list) in the store. Opening a task or project page refreshes a snapshot that is older than **60 seconds**; a fresh one is used as is. Task lists, chips and `get_task` read snapshots only and never call GitHub. A failed fetch never overwrites a good snapshot: it records the failure, and the badge says so.

### Webhook (optional, keeps snapshots current)

Without it, snapshots refresh on page views. With it, merges and reviews show up straight away, without a GitHub call. It needs a publicly reachable deployment whose database has migration 007.

1. Set `GITHUB_WEBHOOK_SECRET` (`openssl rand -hex 32`) on the deployment.
2. In the repo: Settings → Webhooks → Add webhook.
   - **Payload URL:** `https://<your-app>.vercel.app/api/github/webhook`
   - **Content type:** `application/json` (a form-encoded body gets 400)
   - **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
   - **Events:** "Let me select individual events": **Pull requests** and **Pull request reviews**
3. GitHub sends a `ping`; Recent Deliveries should show **204**. A **401** means the secret doesn't match (or isn't set on the deployment).

The route is open to the internet, and the HMAC signature is its only authentication. Events for unlinked or company repos, and other event types, get 204 and change nothing. GitHub doesn't retry failed deliveries: a missed one is corrected by the next page view after 60s, or use Redeliver.

### Sync badge

Each PR on a task page has a badge:

| Badge | Meaning |
| --- | --- |
| `synced 2m ago` | Snapshot from the last successful fetch or webhook |
| `Out of sync · last synced 14m ago` | The last attempt failed; the older snapshot is still shown |
| `Never synced` | No successful fetch yet; only the link to GitHub is shown |

Anything but "synced" opens a details panel: the reason, HTTP status, GitHub's message, request id, last attempt, and **Retry now** (which skips the 60s window). Reasons:

| Reason | Wording |
| --- | --- |
| `github_down` | GitHub is unavailable |
| `timeout` | GitHub didn't respond in time |
| `bad_token` | Token invalid or expired |
| `no_access` | Repo renamed, deleted or not granted to the token |
| `rate_limited` | Rate-limited until `<UTC time>` |
| `not_linked` | Repo isn't linked to this project |
| `company` | Company projects don't read GitHub |

On a rate limit, `retry_after` is taken from GitHub's headers (capped at 1 hour, default 60s). Nothing calls GitHub for that PR or repo before then, Retry now included. The limit is tracked per PR or repo key, so opening a different PR can still make its own call. `get_task` returns `sync` as `{sync, fetched_at, reason}` plus `message` and `retry_after` when they apply.

### Known limits

- Requested *teams* aren't shown, only requested people.
- Only the first 100 reviews of a PR are read, and the open-PR list is capped at 100.
- Badge times are UTC, not the settings timezone.
- Raw HTML in a PR body is shown as escaped text, not rendered.

### Task comments

Every task (on any project, company ones included) has a comment log: plain text, append-only, newest at the bottom. Author is `you` (web) or `agent` (MCP). Add and delete on the task page; agents call `add_comment`, and `get_task` returns the comments oldest first. Comments are not markdown, and my_pm never resolves references in them (a PR link or task code stays text). Over MCP there is no edit or delete.

## Auth

Accounts are email + password (scrypt-hashed). Sessions are stateless HS256 JWTs signed with `JWT_SECRET`.

| `JWT_SECRET` | Mode |
| --- | --- |
| set, at least 32 characters | Accounts: pages need a session; `/api/*` takes a session or a Bearer token |
| unset, locally | Open: no login (the default for `npm run dev`) |
| unset on Vercel, or shorter than 32 characters | Locked: every request is refused, and `/login` says why |

Generate it with `openssl rand -hex 32`. To try auth locally, put it in `.env.local`, create an API key (`npm run auth:create-key`) and set the Bearer value in `.mcp.json` to it.

- **Sign-up.** The first account can always sign up at `/signup`, which bootstraps the workspace. After that, sign-up is closed except for the emails in `PM_SIGNUP_EMAILS` (comma-separated). There are no roles: every account sees everything. Passwords are 10–256 characters and can't be the email.
- **Sessions.** The token sits in the httpOnly `pm_session` cookie and lasts 2 hours. While you're active, the proxy re-issues it once less than an hour is left, for up to 30 days after you logged in; then you log in again. Logout clears the cookie. Nothing is stored server-side, so a token stays valid until it expires, and rotating `JWT_SECRET` logs everyone out.
- **Agents.** Send `Authorization: Bearer <API_KEY>` to `/api/mcp`; see [Agent authentication](#agent-authentication). `PM_SECRET`, if set, still works as a legacy shared bearer secret. A session token also works as a Bearer, for its 2 hours; a Bearer header takes precedence over the cookie.

The JSON endpoints take `Content-Type: application/json`, return errors as `{ error, message }` and answer 503 `not_configured` unless `JWT_SECRET` is set:

| Endpoint | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/signup` | `{ email, password, confirm? }` | 201 `{ token, expires_at, user }`, sets the cookie | 400 `invalid_input` / `invalid_email` / `invalid_password` / `password_mismatch`, 403 `signup_closed`, 409 `email_taken` |
| `POST /api/auth/login` | `{ email, password }` | 200 `{ token, expires_at, user }`, sets the cookie | 400 `invalid_input`, 401 `invalid_credentials` (unknown email and wrong password alike) |
| `POST /api/auth/logout` | – | 200 `{ ok: true }`, clears the cookie | – |

```bash
TOKEN=$(curl -s http://localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…"}' | jq -r .token)
# then: -H "Authorization: Bearer $TOKEN"
```

`src/lib/auth/flow.test.ts` drives these routes, the proxy and `/api/mcp` end to end on both storage backends.

### Agent authentication

With `JWT_SECRET` set, agents authenticate to `/api/mcp` with an API key (`pm_…`). Only its SHA-256 hash is stored: the key is shown once at creation and can't be recovered. Revocation takes effect on the next request.

**Web UI (recommended).** Log in and open **Connect** → **API keys**: name a key, create it, and copy it (or the ready-made `claude mcp add` command) from the one-time reveal. The list shows your keys' labels, creation and last-use dates, and a **Revoke** button. Keys created there belong to your account (`user_id`), you only see and revoke your own, and only a logged-in session can create or revoke them (an API key or `PM_SECRET` can't mint keys). An account can hold 20 active keys.

**CLI.** For scripts, or before anyone has signed up:

```bash
npm run auth:create-key -- --label laptop   # prints the key once; no owner ("cli")
npm run auth:list-keys                      # every key: id (K-n), label, owner, created, last used, status; never the key
npm run auth:revoke-key -- K-3              # any key, idempotent
```

The commands act on whichever store the env selects: Postgres via `DATABASE_URL` in `.env.local`, otherwise `./data`. A key only works against the database the deployment reads, so to issue one for production, run them with production's `DATABASE_URL` set in the shell (it overrides `.env.local`; `vercel env pull .env.production.local` fetches it without clobbering your dev env), plus `NEON_BRANCH=production` so the output names the right branch.

Configure the client with the key as a header. Claude Code:

```bash
claude mcp add --transport http --scope user my-pm https://<your-app>.vercel.app/api/mcp \
  --header "Authorization: Bearer $PM_API_KEY"
```

`.mcp.json` (or any client's `mcpServers` config):

```json
{ "mcpServers": { "my-pm": { "type": "http", "url": "https://<your-app>.vercel.app/api/mcp",
  "headers": { "Authorization": "Bearer pm_…" } } } }
```

**Rotation.** Create a new key, update `headers.Authorization` in the client, reconnect, then revoke the old key.

**Troubleshooting.** A missing, malformed, unknown or revoked key gets 401 `{"error":"unauthorized","message":…}` with `WWW-Authenticate: Bearer realm="pm"`. Claude Code reports this as an auth or 401 error ("needs authentication", "rejected the Authorization header"). Create a new key, update `headers.Authorization`, and reconnect (`/mcp` in Claude Code). If a fresh key is still refused, check that you created it in the same database the deployment uses.

`PM_SECRET` still works as a transitional shared Bearer secret, but prefer keys: each client gets its own, and you can revoke one without touching the others.

## Deploy to Vercel

1. Push this repo and import it into Vercel.
2. Storage: Vercel's filesystem is read-only, so production uses Neon.
   1. Against the `production` branch (its URLs from `neon connection-string production [--pooled]`): `DATABASE_URL_UNPOOLED=… NEON_BRANCH=production npm run db:migrate` (re-run it before deploying any change that adds a migration), then (optionally) `npm run db:import` with the same env to seed it from `./data`.
   2. Set `DATABASE_URL` (the **pooled** production URL) on the Vercel project.
3. Before the first deploy, set `JWT_SECRET` (`openssl rand -hex 32`, at least 32 characters) on the Vercel project. Without it, or with a shorter one, the deployment is locked and refuses all requests. Also set `PM_SIGNUP_EMAILS` if others should be able to sign up. (`PM_SECRET` is optional, a legacy agent secret.)
4. Deploy, then sign up at `/signup` right away: the first account bootstraps the workspace and closes sign-up, so don't leave it for someone else to claim.
5. Create an API key at **Connect** → **API keys** (or with `DATABASE_URL=<pooled production URL> NEON_BRANCH=production npm run auth:create-key -- --label laptop`) and connect Claude Code with it:

   ```bash
   claude mcp add --transport http --scope user my-pm https://<your-app>.vercel.app/api/mcp \
     --header "Authorization: Bearer $PM_API_KEY"
   ```

Settings come from the store (`settings` table, or `settings.yaml`); until they're saved, the defaults plus `PM_TIMEZONE` apply. Set them with the `update_settings` tool.

**Rollback.** Take a backup first (`npm run db:export -- --to …`). Restore with Neon's point-in-time restore, or re-import an export into a fresh branch with `npm run db:import -- --replace` (`PM_DATA_DIR` pointing at the export).

## Layout

```
src/lib/scheduler.ts     scheduling algorithm (pure, tested)
src/lib/lifecycle.ts     lifecycle engine: checks, next actions, warnings (pure, tested)
src/lib/playbook.ts      compiled playbook and stored version schemas
src/lib/playbooks/       seed playbooks (sdlc@1.0.0)
src/lib/estimation.ts    PERT, rollups, calibration stats
src/lib/repo.ts          projects/milestones/tasks/settings/users: validation, codes and domain rules
src/lib/codes.ts         code formats, parsing, natural ordering, UUID v7 ids
src/lib/record-markdown.ts  records as editable markdown (frontmatter + body) and back to a patch
src/lib/record-edit.ts   saving an edited record, with the stale check
src/lib/repository/      storage backends behind repo.ts: Postgres and markdown files
src/lib/store/           file store for the markdown backend (local fs)
src/lib/db.ts            Neon clients (pooled for the app, unpooled for scripts)
migrations/              SQL schema, applied by `npm run db:migrate`
scripts/                 db:smoke, db:migrate, db:import, db:export, auth:*-key(s)
src/lib/github/          GitHub: client (server-only), overview/sync/webhook (pure), pull (page-open sync), views
src/app/api/github/webhook/  GitHub webhook (HMAC-authenticated)
src/lib/mcp/             MCP tools, prompts, server instructions
src/app/api/mcp/         MCP endpoint (+ WebMCP bridge script)
src/app/api/playbooks/   POST a compiled playbook version (what pm-flow calls)
src/lib/auth/            auth modes, password hashing, JWTs, sessions, sign-up/login, API keys
src/app/api/auth/        JSON sign-up, login, logout
src/app/(app)/           web UI
src/components/          UI components (record-editor, copy-code, task table, Gantt, …)
src/app/login, signup    login and sign-up pages
src/proxy.ts             auth for pages and the API, session renewal
```

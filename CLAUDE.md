@AGENTS.md

# my_pm

Personal PM app: markdown store (Project → Milestone → Task) + deterministic scheduler + MCP server (`/api/mcp`) for AI agents. See README.md.

- Tasks reach their project only through `milestone`; inheritance (priority, deadline, on-hold) lives in `src/lib/hierarchy.ts` — use it rather than re-deriving.
- Records have an immutable uuid `id` (PK; all references use it) and a human `code` (`PMA`, `PMA-M1`, `PMA-M1-T3`). Codes are built only in `src/lib/repo.ts` from `src/lib/codes.ts`, which also keeps them in step on project-code changes and moves; numbers come from the parent's counter via `Repository.allocateNumbers` and are never reused.
- Keep `src/lib/scheduler.ts` pure and covered by `src/lib/scheduler.test.ts`; run `npm test` after touching scheduling or estimation.
- Lifecycle: stages are fixed (`LIFECYCLE_STAGES` in `src/lib/types.ts`); playbooks (`src/lib/playbook.ts`) only add checks keyed `<stage>.<name>`. What's open and what's next live in `src/lib/lifecycle.ts`, which is pure and covered by `lifecycle.test.ts`. The writes in `repo.ts` (`advanceStage`, `setCheck`, …) evaluate milestones through its `milestoneLifecycle`, so writes and views agree.
- Playbook versions are insert-only (`syncPlaybook` hashes key-sorted JSON); roll back by re-pinning. Company playbooks are stored without check, principle or environment text.
- All persistence goes through `src/lib/repo.ts` → `Repository` (`src/lib/repository/`: Postgres via `DATABASE_URL`, or markdown files on the local fs). Never write files or SQL outside a repository.
- Schema changes: add a new `migrations/NNN_*.sql` (never edit an applied one), run `npm run db:migrate` on your dev branch; `npm test` covers both backends.
- New task/milestone fields: add to the zod schema in `src/lib/types.ts` (key order there is the frontmatter order; Postgres column names are the same keys, so add a migration too), then expose via `TaskPatch`/`NewTask` in `repo.ts` and the MCP tools.
- GitHub (see README "GitHub integration"): code lives in `src/lib/github/`. `overview.ts`, `sync.ts`, `webhook.ts` and the `*-view.ts` files are pure; `client.ts` (reads `GITHUB_TOKEN`) and `pull.ts` are server-only, and `client.ts` must never be imported from client components.
- PR snapshots and task comments persist only through `repo.ts` → `Repository`. Views and `get_task` read snapshots only; only page opens and Retry now go through `pull.ts`.
- Every GitHub read is gated by `githubRepoAccess` (personal project + linked repo) at read time. Build PR links from the ref with `prUrl`, never from snapshot URLs. Anything that may hold a secret goes through `redact`.
- `/api/github/webhook` is the only unauthenticated route besides the auth pages (HMAC-verified); keep the exact-path exemption in `src/proxy.ts`.
- Checks: `npm run typecheck && npm run lint && npm test && npm run build`.

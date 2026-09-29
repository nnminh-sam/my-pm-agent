-- GitHub integration (PMA-M9): tasks reference the pull requests they cover, PR overviews fetched from GitHub are
-- kept as snapshots (the cache, the fallback when GitHub is unreachable, and the only source for task lists and MCP),
-- and every task gets a plain-text comment log. Columns mirror TaskMeta, GithubSnapshot and TaskComment in
-- src/lib/types.ts.

-- PR references as `owner/repo#123` (repo.ts normalizes URLs to that form).
alter table tasks add column prs text[] not null default '{}';

-- One row per PR (`pr:owner/repo#123`) or per repo's open-PR list (`repo:owner/repo`). `data` and `fetched_at` stay
-- null until a fetch succeeds; a failed attempt sets last_attempt_at / last_error (and retry_after when GitHub sent a
-- reset time) and keeps the previous data. Validated by the app beyond these shapes.
create table github_snapshots (
  key text primary key check (
    key ~ '^(pr:[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}#[1-9][0-9]*|repo:[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100})$'
  ),
  data jsonb check (jsonb_typeof(data) in ('object', 'array')),
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_error jsonb check (jsonb_typeof(last_error) = 'object'),
  retry_after timestamptz
);

-- Plain text, append-only (a comment is added or deleted, never edited); comments go with their task.
create table task_comments (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  author text not null check (author in ('you', 'agent')),
  created_at timestamptz not null,
  body text not null check (body <> '')
);

-- A task's comments, oldest first.
create index task_comments_task on task_comments (task_id, created_at, id);

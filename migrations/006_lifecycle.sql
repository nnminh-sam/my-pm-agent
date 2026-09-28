-- Lifecycle status (PMA-M6): projects pin a playbook version, milestones track their lifecycle stage, check results
-- and the environments they've reached. Columns mirror ProjectMeta / MilestoneMeta in src/lib/types.ts; playbook
-- versions mirror PlaybookVersion in src/lib/playbook.ts.

-- Insert-only: a version is never changed or deleted, so a project can always be pinned back to it.
create table playbook_versions (
  ref text primary key check (ref = name || '@' || version),
  name text not null check (name ~ '^[A-Za-z][A-Za-z0-9-]{0,39}$'),
  version text not null check (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  synced_at timestamptz not null,
  -- The compiled playbook (checks, principles, environments, detectors); validated by the app. json, not jsonb, so
  -- its key order (the order checks are listed in) survives.
  definition json not null check (json_typeof(definition) = 'object')
);

alter table projects
  add column context text not null default 'personal' check (context in ('personal', 'company')),
  add column playbook text references playbook_versions (ref) on delete restrict,
  add column repos text[] not null default '{}',
  add column detectors text[] not null default '{}';

alter table milestones
  add column stage text check (
    stage in ('idea', 'spec', 'design', 'plan', 'build', 'verify', 'release', 'learn', 'maintain')
  ),
  add column checks jsonb not null default '{}' check (jsonb_typeof(checks) = 'object'),
  add column deployments jsonb not null default '{}' check (jsonb_typeof(deployments) = 'object');

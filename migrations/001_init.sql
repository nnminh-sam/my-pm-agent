-- Columns mirror ProjectMeta / FeatureMeta / TaskMeta in src/lib/types.ts; the markdown body is a text column.
-- Ids keep their T-n / F-n / PRJ-n form, allocated from one sequence per prefix.

create sequence project_id_seq;
create sequence feature_id_seq;
create sequence task_id_seq;

create table projects (
  id text primary key default ('PRJ-' || nextval('project_id_seq')) check (id ~ '^PRJ-[0-9]+$'),
  title text not null,
  status text not null default 'active' check (status in ('planned', 'active', 'on_hold', 'done', 'cancelled')),
  priority text not null default 'P2' check (priority in ('P0', 'P1', 'P2', 'P3')),
  deadline date,
  created date not null,
  body text not null default ''
);
alter sequence project_id_seq owned by projects.id;

create table features (
  id text primary key default ('F-' || nextval('feature_id_seq')) check (id ~ '^F-[0-9]+$'),
  title text not null,
  status text not null default 'planned' check (status in ('idea', 'planned', 'in_progress', 'done', 'cancelled')),
  project text references projects (id) on delete restrict,
  priority text check (priority in ('P0', 'P1', 'P2', 'P3')),
  deadline date,
  created date not null,
  body text not null default ''
);
alter sequence feature_id_seq owned by features.id;
create index features_project_idx on features (project);

-- depends_on is an ordered text[] rather than a join table: the order is part of the domain output,
-- and dependency existence + cycles are already validated in src/lib/repo.ts.
create table tasks (
  id text primary key default ('T-' || nextval('task_id_seq')) check (id ~ '^T-[0-9]+$'),
  title text not null,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text check (priority in ('P0', 'P1', 'P2', 'P3')),
  feature text references features (id) on delete restrict,
  estimate double precision check (estimate >= 0),
  estimate_range double precision[] check (
    estimate_range is null
    or (cardinality(estimate_range) = 2 and estimate_range[1] >= 0 and estimate_range[2] >= 0)
  ),
  spent double precision not null default 0 check (spent >= 0),
  deadline date,
  not_before date,
  depends_on text[] not null default '{}',
  tags text[] not null default '{}',
  "order" double precision,
  created date not null,
  completed date,
  body text not null default ''
);
alter sequence task_id_seq owned by tasks.id;
create index tasks_feature_idx on tasks (feature);

-- Single row holding the settings object as stored (defaults are applied when parsing it).
-- json rather than jsonb keeps key order, so an export reads like the original settings.yaml.
create table settings (
  id boolean primary key default true check (id),
  data json not null
);

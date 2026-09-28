-- Features become milestones, and every workspace record gets an opaque uuid id (the primary key) separate from
-- its human code: projects PMA (chosen), milestones PMA-M1 (numbered within their project), tasks PMA-M1-T1
-- (numbered within their milestone). Columns mirror ProjectMeta / MilestoneMeta / TaskMeta in src/lib/types.ts.
--
-- `number` plus the parent's code make the code; `code` is a stored copy kept in step by src/lib/repo.ts (a
-- generated column can't span tables). Parents count the numbers they've handed out (last_*_number), so a number
-- is never reused, even after its item moves away. References (project, milestone, depends_on) hold ids, so they
-- survive code changes.
--
-- Existing rows: PRJ-n gets code Pn (change it with update_project), features are numbered per project and tasks
-- per feature in id order, depends_on is remapped in order (dangling ids, which the scheduler already ignored,
-- are dropped), and old ids in markdown bodies are rewritten to codes.

do $$
begin
  if exists (select 1 from features where project is null) then
    raise exception 'Every feature needs a project before it can become a milestone (features without one: %)',
      (select string_agg(id, ', ') from features where project is null);
  end if;
  if exists (select 1 from tasks where feature is null) then
    raise exception 'Every task needs a feature before it can get a code (tasks without one: %)',
      (select string_agg(id, ', ') from tasks where feature is null);
  end if;
end $$;

-- Old id → new id and code.
create temp table p_map on commit drop as
  select id as old_id, uuidv7() as new_id, 'P' || split_part(id, '-', 2) as code
  from projects;

create temp table m_map on commit drop as
  select old_id, new_id, project, number, project_code || '-M' || number as code
  from (
    select f.id as old_id, uuidv7() as new_id, p.new_id as project, p.code as project_code,
      row_number() over (partition by f.project order by split_part(f.id, '-', 2)::int)::int as number
    from features f
    join p_map p on p.old_id = f.project
  ) numbered;

create temp table t_map on commit drop as
  select old_id, new_id, milestone, number, milestone_code || '-T' || number as code
  from (
    select t.id as old_id, uuidv7() as new_id, m.new_id as milestone, m.code as milestone_code,
      row_number() over (partition by t.feature order by split_part(t.id, '-', 2)::int)::int as number
    from tasks t
    join m_map m on m.old_id = t.feature
  ) numbered;

create temp table old_projects on commit drop as select * from projects;
create temp table old_features on commit drop as select * from features;
create temp table old_tasks on commit drop as select * from tasks;

-- Their id sequences are owned by the id columns and go with them.
drop table tasks;
drop table features;
drop table projects;

create table projects (
  id uuid primary key default uuidv7(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9]{1,5}$'),
  title text not null,
  status text not null default 'active' check (status in ('planned', 'active', 'on_hold', 'done', 'cancelled')),
  priority text not null default 'P2' check (priority in ('P0', 'P1', 'P2', 'P3')),
  deadline date,
  created date not null,
  last_milestone_number integer not null default 0 check (last_milestone_number >= 0),
  body text not null default ''
);

-- unique (project, number) also serves lookups by project.
create table milestones (
  id uuid primary key default uuidv7(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9]{1,5}-M[1-9][0-9]*$'),
  number integer not null check (number > 0),
  title text not null,
  status text not null default 'planned' check (status in ('idea', 'planned', 'in_progress', 'done', 'cancelled')),
  project uuid not null references projects (id) on delete restrict,
  priority text check (priority in ('P0', 'P1', 'P2', 'P3')),
  deadline date,
  created date not null,
  last_task_number integer not null default 0 check (last_task_number >= 0),
  body text not null default '',
  unique (project, number)
);

-- depends_on stays an ordered array (see 001_init.sql), now of task ids; unique (milestone, number) serves
-- lookups by milestone.
create table tasks (
  id uuid primary key default uuidv7(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9]{1,5}-M[1-9][0-9]*-T[1-9][0-9]*$'),
  number integer not null check (number > 0),
  title text not null,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text check (priority in ('P0', 'P1', 'P2', 'P3')),
  milestone uuid not null references milestones (id) on delete restrict,
  estimate double precision check (estimate >= 0),
  estimate_range double precision[] check (
    estimate_range is null
    or (cardinality(estimate_range) = 2 and estimate_range[1] >= 0 and estimate_range[2] >= 0)
  ),
  spent double precision not null default 0 check (spent >= 0),
  deadline date,
  not_before date,
  depends_on uuid[] not null default '{}',
  tags text[] not null default '{}',
  "order" double precision,
  created date not null,
  completed date,
  body text not null default '',
  unique (milestone, number)
);

insert into projects (id, code, title, status, priority, deadline, created, last_milestone_number, body)
select p.new_id, p.code, o.title, o.status, o.priority, o.deadline, o.created,
  (select count(*) from m_map m where m.project = p.new_id), o.body
from old_projects o
join p_map p on p.old_id = o.id;

insert into milestones (id, code, number, title, status, project, priority, deadline, created, last_task_number, body)
select m.new_id, m.code, m.number, o.title, o.status, m.project, o.priority, o.deadline, o.created,
  (select count(*) from t_map t where t.milestone = m.new_id), o.body
from old_features o
join m_map m on m.old_id = o.id;

insert into tasks (
  id, code, number, title, status, priority, milestone, estimate, estimate_range, spent, deadline, not_before,
  depends_on, tags, "order", created, completed, body
)
select t.new_id, t.code, t.number, o.title, o.status, o.priority, t.milestone, o.estimate, o.estimate_range,
  o.spent, o.deadline, o.not_before,
  array(
    select d.new_id
    from unnest(o.depends_on) with ordinality as dep (old_id, ord)
    join t_map d on d.old_id = dep.old_id
    order by dep.ord
  ),
  o.tags, o."order", o.created, o.completed, o.body
from old_tasks o
join t_map t on t.old_id = o.id;

-- Old ids mentioned in markdown (e.g. "after T-3") become codes. \m…\M are word boundaries, so T-3 never
-- matches inside T-30, and no code contains an old id, so replacements can't cascade.
create temp table id_map on commit drop as
  select old_id, code from p_map
  union all select old_id, code from m_map
  union all select old_id, code from t_map;

do $$
declare
  r record;
  pattern text;
begin
  for r in select old_id, code from id_map loop
    pattern := '\m' || r.old_id || '\M';
    update projects set body = regexp_replace(body, pattern, r.code, 'g') where body ~ pattern;
    update milestones set body = regexp_replace(body, pattern, r.code, 'g') where body ~ pattern;
    update tasks set body = regexp_replace(body, pattern, r.code, 'g') where body ~ pattern;
  end loop;
end $$;

do $$
begin
  if (select count(*) from projects) <> (select count(*) from old_projects)
    or (select count(*) from milestones) <> (select count(*) from old_features)
    or (select count(*) from tasks) <> (select count(*) from old_tasks) then
    raise exception 'Row counts changed while migrating to milestones';
  end if;
  if exists (
    select 1 from id_map m
    where exists (select 1 from projects where body ~ ('\m' || m.old_id || '\M'))
      or exists (select 1 from milestones where body ~ ('\m' || m.old_id || '\M'))
      or exists (select 1 from tasks where body ~ ('\m' || m.old_id || '\M'))
  ) then
    raise exception 'An old id is still mentioned in a markdown body';
  end if;
end $$;

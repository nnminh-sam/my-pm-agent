-- Drop the project context field (PMA-M17-T5) as the app is now for personal projects only.
-- This migration runs only after the code that no longer reads `context` is deployed, because the old code selects that column.

do $$
declare
  company_codes text;
begin
  select string_agg(code, ', ' order by code) into company_codes from projects where context = 'company';
  if company_codes is not null then
    raise exception 'projects % are still company; set their context to ''personal'' (or delete them) before running 008', company_codes;
  end if;
end $$;

alter table projects drop column context;

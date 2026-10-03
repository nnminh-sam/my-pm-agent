-- Drop the project context field (PMA-M17-T5) as the app is now for personal projects only.
-- All behaviors that depended on this field (GitHub integration differences, playbook stripping,
-- lifecycle check text) have already been removed.
--
-- Fails if any project is still a company project to prevent accidental data loss.

DO $$
DECLARE
  company_codes text;
BEGIN
  SELECT string_agg(code, ', ') INTO company_codes FROM projects WHERE context = 'company';
  IF company_codes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot drop context column: projects % are still company projects', company_codes;
  END IF;
END $$;

ALTER TABLE projects DROP COLUMN context;

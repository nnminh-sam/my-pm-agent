# Personal projects only: sequences

Milestones: PMA-M17 · Updated: 2026-10-03

## PO-1 Dropping the column

`npm run db:migrate` runs migration `008_drop_project_context.sql`. The guard query checks for any company projects; if any exist, it raises an error and rolls back so nothing changes. Otherwise, `projects.context` is dropped. Note that the guard is Postgres-only.

```mermaid
sequenceDiagram
  actor Admin as Developer / CI
  participant Script as npm run db:migrate
  participant DB as Postgres

  Admin->>Script: run db:migrate
  Script->>DB: execute 008_drop_project_context.sql
  DB->>DB: guard: check for projects with context = 'company'
  alt company projects found
    DB-->>Script: raise exception (transaction rollback)
    Script-->>Admin: migration failed; schema and data unchanged
  else no company projects
    DB->>DB: alter table projects drop column context
    DB-->>Script: success
    Script-->>Admin: migration 008 applied
  end
```

## PO-2 The PR read gate

Checked when viewing PR data or receiving webhook deliveries. If a repository is linked to any project, access is allowed; if unlinked, it is refused without contacting GitHub.

```mermaid
sequenceDiagram
  actor Caller as User / GitHub Webhook
  participant App as Page open / Webhook route
  participant Gate as githubRepoAccess
  participant GH as GitHub API
  participant Store as Repository (snapshots)

  Caller->>App: open page (pull) or POST /api/github/webhook
  App->>Gate: check access for repo

  alt linked to a project (allowed)
    Gate-->>App: { allowed: true }
    alt page open
      App->>Store: getGithubSnapshot(key)
      opt fetch needed (missing or older than 60 s)
        App->>GH: GET PR / repo details
        GH-->>App: data
        App->>Store: upsertGithubSnapshot(snapshot)
      end
      App-->>Caller: render page with PR data
    else webhook delivery
      App->>Store: upsertGithubSnapshot(applied event)
      App-->>Caller: 204 No Content
    end
  else linked to no project (not_linked)
    Gate-->>App: { allowed: false, refusal: "not_linked", message }
    alt page open
      App-->>Caller: render unlinked status (no GitHub call)
    else webhook delivery
      App-->>Caller: 204 No Content (nothing stored, no GitHub call)
    end
  end
```

## PO-3 Playbook sync

When `pm-flow` publishes a compiled playbook via `POST /api/playbooks` or an agent calls the `sync_playbook` MCP tool, `syncPlaybook` validates and stores the definition exactly as sent, keeping all check descriptions, principles, and environment details. No metadata-only stripping occurs.

```mermaid
sequenceDiagram
  actor Caller as pm-flow (POST /api/playbooks) / Agent (sync_playbook)
  participant Endpoint as API route / MCP tool
  participant Core as syncPlaybook
  participant Store as Repository (playbook_versions)

  Caller->>Endpoint: send compiled playbook payload
  alt invalid JSON / schema parse error
    Endpoint-->>Caller: 400 invalid_input / tool error
  else valid input
    Endpoint->>Core: syncPlaybook(body)
    Core->>Core: Playbook.parse(body) (definition kept whole)
    Core->>Core: hashPlaybook(definition)
    Core->>Store: getPlaybookVersion(ref)
    alt new version
      Core->>Store: insertPlaybookVersion(version)
      Core-->>Endpoint: { version, created: true }
      Endpoint-->>Caller: 201 Created (or tool success)
    else already stored with identical hash
      Core-->>Endpoint: { version, created: false }
      Endpoint-->>Caller: 200 OK (created: false)
    else already stored with different hash
      Core-->>Endpoint: throw ConflictError
      Endpoint-->>Caller: 409 Conflict (version_changed)
    end
  end
```

## PO-4 No company rules left

PO-4 is checked by grep and a plan sweep at verify, so it has no sequence.

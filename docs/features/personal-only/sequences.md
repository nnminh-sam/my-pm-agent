# Personal projects only: sequences

Milestones: PMA-M17 · Updated: 2026-10-03

## The PR read gate

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
      opt fetch needed
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
    Gate-->>App: { allowed: false, refusal: "not_linked" }
    alt page open
      App-->>Caller: render unlinked status (no GitHub call)
    else webhook delivery
      App-->>Caller: 204 No Content (nothing stored, no GitHub call)
    end
  end
```

## Playbook sync

When `pm-flow` publishes a compiled playbook, `syncPlaybook` validates and stores the definition exactly as sent, keeping all check descriptions, principles, and environment details. No metadata-only stripping occurs.

```mermaid
sequenceDiagram
  actor Flow as pm-flow
  participant API as POST /api/playbooks
  participant Repo as syncPlaybook
  participant Store as Repository (playbook_versions)

  Flow->>API: POST /api/playbooks (JSON definition)
  API->>Repo: syncPlaybook(body)
  Repo->>Repo: Playbook.parse(body) (definition kept whole)
  Repo->>Repo: hashPlaybook(definition)
  Repo->>Store: getPlaybookVersion(ref)
  alt new version
    Repo->>Store: insertPlaybookVersion(version)
    Repo-->>API: { version, created: true }
    API-->>Flow: 201 Created { ref, hash, synced_at, created: true }
  else already stored with identical hash
    Repo-->>API: { version, created: false }
    API-->>Flow: 200 OK { ref, hash, synced_at, created: false }
  else already stored with different hash
    Repo-->>API: throw ConflictError
    API-->>Flow: 409 Conflict (version_changed)
  end
```

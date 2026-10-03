# Pending feedback: sequences

Milestones: PMA-M12 · Updated: 2026-10-03

## PF-1 Run an action: a form

Login, sign-up, log out, log time, comment, add repo, create key.

```mermaid
sequenceDiagram
  actor User
  participant Form as form (server component or client)
  participant Btn as SubmitButton
  participant Action as server action
  participant Repo as Repository
  User->>Form: submit
  Form->>Action: POST (Next-Action)
  Form-->>Btn: useFormStatus().pending = true
  Btn-->>User: disabled, aria-busy, spinner, "Saving…" status
  opt PF-1a submits again
    User->>Btn: click / Enter
    Btn-->>User: ignored (disabled)
  end
  Action->>Repo: write
  alt ok
    Action-->>Form: result / redirect / revalidate
  else fails (PF-1b)
    Action-->>Form: { ok: false, message } or error
  end
  Form-->>Btn: pending = false
  Btn-->>User: idle, result or error message
```

## PF-1 Run an action: an inline control

Status select, Delete, Remove, Revoke, Retry now, Reload, record Save.

```mermaid
sequenceDiagram
  actor User
  participant Ctl as call site (useTransition / useActionState)
  participant Btn as PendingButton
  participant Action as server action
  User->>Ctl: click / change / ⌘Enter
  Ctl->>Action: startTransition(action)
  Ctl-->>Btn: pending = true
  Btn-->>User: disabled, aria-busy, spinner, status text
  Action-->>Ctl: result
  alt { ok: false } or thrown (PF-1b)
    Ctl-->>User: existing error message
  end
  Ctl-->>Btn: pending = false
  Btn-->>User: idle
```

## PF-2 Open another page

```mermaid
sequenceDiagram
  actor User
  participant Router as App Router
  participant Instr as instrumentation-client onRouterTransitionStart
  participant Bar as NavigationProgress
  participant Loading as (app)/loading.tsx PageSkeleton
  participant Server as page render
  User->>Router: click link / change Gantt filter / back
  Router->>Instr: onRouterTransitionStart(url)
  Instr->>Bar: start (150 ms delay)
  Router->>Server: RSC request
  Router-->>Loading: show skeleton (prefetched loading state)
  alt answer within 150 ms (PF-2a)
    Server-->>Router: payload
    Router-->>User: new page, bar never shown
  else slow
    Bar-->>User: bar at the top
    Loading-->>User: skeleton, aria-busy, "Loading…"
    Server-->>Router: payload
    Router-->>User: new page, skeleton and bar removed
  end
```

## PF-3 Refresh the page

```mermaid
sequenceDiagram
  actor User
  participant Btn as RefreshButton (header)
  participant Router as App Router
  participant Server as page render
  User->>Btn: click / press r (not in a field)
  Btn->>Router: startTransition(router.refresh())
  Btn-->>User: disabled, aria-busy, spinner, "Refreshing…" status
  Router->>Server: RSC request (no document reload)
  Server-->>Router: fresh payload
  Router-->>User: server components updated; client state (filters, scroll, editor draft) kept
  Btn-->>User: idle, "Updated just now"
```

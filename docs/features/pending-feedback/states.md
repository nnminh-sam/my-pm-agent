# Pending feedback: states

Milestones: PMA-M12 · Updated: 2026-10-03

No stored record has a lifecycle here. These are the UI states of the three things the feature adds.

## Action trigger

A submit button or inline control from PF-1.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> pending: PF-1 submit / use
  pending --> pending: PF-1a click or submit again (ignored)
  pending --> idle: server answers (PF-1 result, PF-1b error)
```

| From | To | Use case | Guard | Effect |
| --- | --- | --- | --- | --- |
| idle | pending | PF-1 | — | One request sent; disabled, `aria-busy`, spinner, status text |
| pending | pending | PF-1a | — | Nothing sent |
| pending | idle | PF-1, PF-1b | The action settled (ok, `{ ok: false }`, or thrown) | Enabled; result or error shown |

## Navigation progress

The top bar and skeleton from PF-2.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> waiting: PF-2 navigation starts
  waiting --> idle: PF-2a new page within 150 ms
  waiting --> visible: 150 ms pass
  visible --> idle: PF-2 new page shown, PF-2b error page shown
```

| From | To | Use case | Guard | Effect |
| --- | --- | --- | --- | --- |
| idle | waiting | PF-2 | App Router transition started | Timer starts; nothing visible yet (the skeleton may already show) |
| waiting | idle | PF-2a | Committed before 150 ms | Bar never shown |
| waiting | visible | PF-2 | 150 ms passed | Bar shown |
| visible | idle | PF-2, PF-2b | New page (or error page) rendered | Bar and skeleton removed |

## Refresh button

The header button from PF-3.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> pending: PF-3 click or `r`
  pending --> pending: PF-3b click or `r` again (ignored)
  pending --> idle: fresh render arrived
  idle --> idle: PF-3a `r` in a field (ignored)
```

| From | To | Use case | Guard | Effect |
| --- | --- | --- | --- | --- |
| idle | pending | PF-3 | Click, or bare `r` outside a field | `router.refresh()` in a transition; disabled, `aria-busy`, spinner, status text |
| pending | pending | PF-3b | — | Nothing sent |
| pending | idle | PF-3 | Server components re-rendered | Enabled; "Updated just now" |
| idle | idle | PF-3a | Focus in input/textarea/select/contenteditable, or a modifier held | Nothing |

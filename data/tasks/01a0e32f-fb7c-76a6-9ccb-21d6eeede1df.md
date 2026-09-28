---
id: 01a0e32f-fb7c-76a6-9ccb-21d6eeede1df
code: PMA-M3-T3
number: 3
title: Extract a Repository interface from repo.ts; move file logic into FileRepository
status: done
milestone: 01a0e32f-fb7b-7457-8963-7f5ac82a854d
estimate: 2
estimate_range: [1, 3.5]
spent: 0
tags: [backend, refactor]
created: 2026-09-27
completed: 2026-09-27
---

- Keep repo.ts's public API (`loadWorkspace`, `getTask`, `createTasks`, `updateTask`, `logTime`, `reorderTasks`, feature/project/settings CRUD, zod input shapes) unchanged for the MCP tools and UI.
- Validation that's backend-agnostic (ref resolution, cycle check, pert, id normalization) stays shared; storage specifics (`loadDir`, `createWithNextId`, serialize/parse markdown) move into `FileRepository` over `FileStore`.
- No behavior change.

**Done when:** existing tests pass untouched and `npm run typecheck && npm run lint` are clean.

### Note · 2026-09-27

Done by Claude. src/lib/repository/{types,file,index}.ts: Repository interface; FileRepository holds loadDir/createWithNextId/markdown serialization over FileStore. repo.ts keeps its public API plus shared validation (refs, cycles, pert, ids). Original repo tests passed unchanged before being parametrized in PMA-M3-T7. Small change: duplicate `ref`s in one create_tasks batch are now rejected.

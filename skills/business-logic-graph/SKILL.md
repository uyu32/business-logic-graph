---
name: business-logic-graph
description: Use BLG to progressively inspect, explain, verify and plan business logic in a bound code repository. Store master baselines and development overlays in an independent data Git repository; apply when the user requests BLG or the repository has an external BLG binding.
---

# Business Logic Graph

Business Logic Graph is a Codex plugin. Its Skill controls agent behavior; its
Core and CLI maintain repository data; its Viewer generates a local HTML view.
Keep artifacts in an external BLG data Git repository, never in the target
source repository. The CLI resolves bindings through its local registry.

Treat the external baseline plus branch overlay as a shared business-logic intermediate
representation, not generated prose and not a call graph. The graph is the Git
source of truth; indexes, verification checks and HTML are disposable projections.

## Invariants

- Load the smallest useful subgraph first. Use the CLI `context` command rather
  than placing the entire graph in model context.
- Separate business claims from evidence. A symbol or call relation is evidence
  for a claim, not the claim itself.
- CodeGraph and other providers may propose where to read. Their output remains
  `provider-candidate` until source, configuration, or tests are opened and
  checked at the current repository head.
- Reverify claims directly affected by the request, missing locators, changed
  fingerprints and stale/conflicting/unknown claims. Unchanged file fingerprints
  can reuse previous verification without rereading unrelated code; a new Git
  commit alone does not require rebuilding the entire map.
- Master facts must be read from the configured baseline branch, not inferred
  from feature code. Baseline writes require its clean checkout; use an existing
  master worktree when needed. Never automatically switch the user's checkout.
- Development work saves an overlay only. Do not copy its conclusions into the
  baseline until merged master source/config/tests have been reverified.
- Never overwrite a locked claim or a locked node field. Add a superseding claim
  or ask the user to revise the lock.
- Apply graph changes through a patch envelope. Dry-run it, validate the result,
  then write it atomically.
- Do not give a final development plan while the affected subgraph's required
  claims fail the plan gate.

The plugin CLI is `<plugin-root>/scripts/blg.mjs`. The graph protocol and status
semantics are summarized in [references/protocol.md](references/protocol.md).
For binding, migration, worktrees or data history, read
[references/workspace.md](references/workspace.md).

## Choose the operation

- **initialize**: inspect routes, entrypoints, configuration, tests, and top-level
  application boundaries; create only a coarse business skeleton. Avoid full
  sequential source reading. For a new empty graph, read these entrypoints and
  patch the coarse skeleton before attempting a context query.
- **inspect**: resolve the request to one or more business nodes, load a shallow
  context packet, and verify only the affected subgraph plus immediate flow
  neighbors.
- **explain**: answer from verified claims. If detail is missing, expand one level,
  inspect the relevant repository artifacts, and patch the new conclusion back.
- **plan**: perform `inspect`, patch and validate the graph, run the gate, then
  produce the plan from the verified context. Report blockers instead of
  presenting an unverified plan as final.
- **sync**: after implementation, re-read changed source/config/tests, update
  fingerprints and verification commits, capture newly introduced logic, and
  rerun validation and the gate.

## Operating loop

1. Run `blg status <source-root>` to resolve the independent data repository,
   source revision and baseline/overlay scope. If unbound, initialize externally
   with `blg init <source-root>` only when initialization is requested. A ZIP
   source copy is explicitly snapshot mode, never a pretend master branch.
2. Run `blg validate <source-root>` before trusting context.
3. Run `blg context <source-root> <request-or-node> --depth 1 --max-nodes 32
   --max-chars 24000`. Increase a budget explicitly only when necessary; avoid
   full graph dumps or full sequential source reading.
4. Identify affected required claims and candidate evidence. Read current source,
   configuration, and relevant tests; use CodeGraph only when available and
   helpful, with `rg` and language tooling as fallback. `blg source <source-root>
   <relative-path>` returns scoped source, revision and full-file fingerprint;
   use `--scope baseline` to read committed master source from any worktree.
5. Prepare an RFC 6902 envelope with the observed graph revision and Git head.
   Dry-run `blg patch <source-root> <patch>`, review the diff, then use `--write` when
   updating the graph is part of the user's requested workflow.
   Keep patch files outside the source repository. Include newly read source
   fingerprints, not only a commit or a candidate symbol. If the master graph
   advanced, run an explicit `rebase`; conflicts block planning and require
   human resolution, never silent overwriting.
6. Run `blg validate <source-root>` and `blg gate <source-root> <affected-node...>`.
7. Run `blg render <source-root>` for a one-time standalone HTML refresh. During an
   active graph-editing session, use `blg preview <repository-root>` to compile,
   watch, re-render, and live-reload; stop it when the session ends.
8. Explain or plan using the resulting verified subgraph. Clearly label remaining
   inferences and open questions.

`preview` checks fingerprints and displays stale evidence in its projection;
it never writes the baseline or calls the model. Double-click only opens saved
children, not new AI analysis. Record newly verified conclusions through a patch.
Data commits, remote configuration and pushes require their own user request;
`init` creates its documented first local data commit only.

When initializing a graph or changing protocol-level fields, read
[references/protocol.md](references/protocol.md). When integrating CodeGraph or
another evidence engine, also read
`<plugin-root>/packages/protocol/evidence-provider.md`.

# Independent BLG data repositories

Default data home is `<user-profile>/BLG/data`, configurable with BLG_DATA_HOME
or --data-root. Each `projects/<repo-id>` is a separate Git repository with
`repository.json`, `baseline/graph.json`, `overlays/<scope-key>.json`, and
content-addressed `history/<digest>.json`. Source code stays in its own repository.
The registry outside project Git maps source Git common directories to stable
repo IDs. Local paths and write locks are not committed; HTML is generated and ignored.

## Initialization and migration

`blg init <source-root> --baseline master` creates a coarse empty graph and an
initial local data commit. It does not analyze source by itself. Populate it by
reading scoped source and applying a patch. For an existing map, pass `--import
<old-graph.json>`; its source revision must match the baseline revision. Import
preserves the original separately and checks/captures file fingerprints without
promoting unverified claims. Source-local artifacts are not removed automatically.
Never create source Git history just to make a ZIP look like master.

## Source and write scope

Default scope on master is baseline; on a feature or detached worktree it is
branch. `--scope baseline` reads committed baseline code via Git object access,
but writing still requires a clean baseline checkout. A snapshot has baseline
scope and a deterministic source revision, with no branch guarantees.

Use `blg source <source-root> <relative-path> --start-line N --end-line N` for
bounded source reads. Its fingerprint covers the full file, not the excerpt.
Always read the actual relevant source/config/tests before marking a claim verified.

## Overlays and concurrency

Overlays store RFC 6902 entity changes, stable change-set IDs, revision, source
commit, worktree ID, branch, and a pinned baseline graph digest. Multiple Git
worktrees share the baseline binding but have separate overlays. Branch names
and worktree paths select overlays; renamed or moved contexts require explicit
rebinding/migration rather than guessing that two contexts are identical.
After moving, renaming a branch, or cloning on another device, use `blg overlays`
to list saved change sets and explicitly `blg adopt <source-root>
<overlay-filename>` from the new development worktree. It preserves the original,
retains the stable change-set ID and refuses to overwrite an existing overlay.

Writes use a per-project lock, graph revision and actual source context checks.
The master graph advancing requires explicit `blg rebase <source-root>`.
Three-way entity conflicts and new user locks block rebase/planning. The current
version reports conflicts; resolve them with explicit human review of the data
change set, not a forced automatic choice. Reverify affected code after rebasing.

## History, portability and promotion

`blg commit <source-root> --message TEXT` commits only managed BLG paths.
It refuses unrelated staged files and never commits source, pushes, or changes
global Git configuration. If no Git identity is configured, it uses an explicit
BLG-local author for that command.

To share history, clone this data Git repository separately into a new data
home's `projects/<repo-id>`, then `blg bind <source-root> <repo-id>`.
`blg export <source-root> <new-directory>` exports current data only, not Git
history, source code, generated HTML or machine-local bindings. Initialize Git
on that exported directory separately if needed before data commits.

After code merges, inspect committed master source/config/tests and apply a
new baseline patch from its clean checkout. Do not blindly replay or recolor
the overlay as verified master logic. Archive its data record intentionally.

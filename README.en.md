# Business Logic Graph (BLG)

[中文](README.md) · English

**Business logic people can understand and agents can verify on demand.**

BLG is a Codex plugin that starts with a coarse business map and progressively adds detail as questions arise. Verified conclusions become expandable business blocks. People browse HTML; agents load bounded context from the same representation.

This is not a restyled call graph or a one-time whole-repository documentation generator. Calls and symbols are evidence; scenarios, rules, decisions, and data changes are the map itself.

> Local MVP: the Skill orchestrates analysis, Core/CLI manage persistence and verification gates, and the Viewer displays saved logic. Double-clicking does not invoke a model to generate new logic.

## Implemented

- Arbitrary-depth nodes and focused context. Defaults: depth 1, at most 32 nodes and 24,000 serialized characters. Insufficient budgets fail explicitly.
- Separate business nodes, code facts, model inferences, business confirmations, and source/configuration/test evidence.
- An independent local data Git repository per project, outside target source. No target `.gitignore` changes.
- A configurable baseline (`master` by default, or `main`) and isolated feature/worktree overlays.
- Blue added nodes, orange modifications, red dashed deletion ghosts, and separate verification badges. Deleted nodes are not current agent context.
- Whole-file SHA-256 checks. Unchanged evidence may reuse verification; request-affected logic must still be read.
- RFC 6902 transactions, revision checks, user locks, entity-level three-way comparisons, and conflict blocking.
- Double-click expansion/collapse, refresh-persistent expansion, self-contained HTML, and a rebuilding local preview.

## Workflow

```text
Source / configuration / tests → candidates → agent reads and verifies → business graph
                                                                         ├─ context → agent
                                                                         └─ HTML    → people
```

Before development: locate the business area → load focused context → verify affected evidence → patch the graph → check the gate → produce the final development plan.

CodeGraph is an **optional Evidence Provider** for narrowing the reading range and proposing files, symbols, and call chains. Candidates are not verified facts. BLG owns final source verification, locators, fingerprints, and persistence. A live CodeGraph adapter is not implemented yet.

## Quick start

Build the Viewer with Node.js **22.12+** or a Vite-compatible 20.19+ version, npm, and Git. Core/CLI have no third-party runtime dependencies.

Clone this repository and run from its root:

```sh
npm --prefix apps/viewer ci
npm run check
```

`check` runs Core tests, synthetic example validation, Viewer lint, TypeScript checks, and a production build.

Try the **fictional order-processing example**:

```sh
npm run validate:example
npm run context:example
npm run gate:example
npm --prefix apps/viewer run dev
```

The example is not derived from a real business repository. Its verification revisions are illustrative, not evidence about your target.

### Install as a Codex plugin

The repository includes `.codex-plugin/plugin.json` and `skills/business-logic-graph/`. After building, open it in Codex and ask the built-in Plugin Creator to register and install it through the personal marketplace:

> Use Plugin Creator to register and install this project as the personal Codex plugin business-logic-graph. Validate its manifest and Skill, and preserve existing marketplace entries.

Start a new Codex task after installation to load the Skill. The CLI also works without plugin installation. Cloning or opening HTML alone does not activate the agent workflow.

### Initialize an external map

```sh
node scripts/blg.mjs init /path/to/source --baseline master
# Use --baseline main if that is your primary branch.
node scripts/blg.mjs status /path/to/source
```

Initialization creates a separate data Git repository and its first local commit, not semantic conclusions. In a Codex task with the plugin loaded, ask:

> Use BLG initialize on this repository. Read entrypoints, routes, important configuration, and tests; create only the coarse business skeleton, without reading all source sequentially.

For detail:

> Use BLG explain on “organizations and members”: how is the code organized, and which files and functions matter? Read and verify the relevant source, then save the additional logic and evidence in the graph.

### HTML and live preview

```sh
node scripts/blg.mjs render /path/to/source
node scripts/blg.mjs preview /path/to/source --port 5182 --reuse
```

`render` produces self-contained HTML requiring no deployment or running server. `preview` watches Viewer source, external graph data, and source evidence, refreshing projections without editing semantic conclusions or invoking a model. A source clone needs dependency installation and an initial Viewer build; `--no-build` does not create missing assets.

Windows **cmd.exe** example:

```bat
cd /d "D:\projects\business-logic-graph"
npm --prefix apps/viewer ci
npm run build:viewer
node scripts\blg.mjs init "D:\projects\my-app" --baseline main
scripts\blg.cmd preview "D:\projects\my-app" --port 5182 --reuse
```

In PowerShell, use `Set-Location -LiteralPath "D:\projects\business-logic-graph"`. `Set-Location` is not a CMD command.

## Data storage

Default root: `<user-profile>/BLG/data`. Override it with `BLG_DATA_HOME` or `--data-root`.

```text
BLG/data/
├─ registry.json                 Machine-local bindings, outside project data Git
└─ projects/<repo-id>/            Independent Git repository
   ├─ repository.json            Project/baseline configuration
   ├─ baseline/graph.json        Primary-branch business baseline
   ├─ overlays/                  Branch/worktree changes
   ├─ history/                   Content-addressed graph snapshots
   ├─ imports/                   Migration archives: review before sharing
   └─ viewer/<worktree-id>/       Generated HTML, ignored by data Git
```

The graph uses flat ID maps for `nodes / edges / claims / evidence`. `parentId` defines arbitrary hierarchy; edges describe order and conditions. Context and HTML are rebuildable projections, not a second editable source of truth.

Switching source branches does not delete external records; the view selects the relevant baseline or overlay. Worktrees of the same source Git share a baseline but not a mutable overlay. ZIP source snapshots use explicit SHA-256 snapshot mode: no source `.git` or invented master branch.

## Everyday commands

```sh
node scripts/blg.mjs context /path/to/source "members" --depth 1 --max-nodes 32 --max-chars 24000
node scripts/blg.mjs source /path/to/source src/example.ts --start-line 1 --end-line 120
node scripts/blg.mjs patch /path/to/source /external/path/patch.json
node scripts/blg.mjs patch /path/to/source /external/path/patch.json --write
node scripts/blg.mjs validate /path/to/source
node scripts/blg.mjs gate /path/to/source <affected-node-id>
node scripts/blg.mjs commit /path/to/source --message "Verify member-management rules"
```

`patch` defaults to a dry run. Writes go through the source-path entrypoint to check actual Git context. Baseline writes require a clean checkout of the configured branch; development branches write overlays only. Keep patch files outside source too.

When the baseline advances, explicit `rebase` performs entity-level three-way comparison. Conflicts/new locks block planning. There is no automatic adjudication or overlay promotion: verify primary-branch source after the code merge.

```sh
node scripts/blg.mjs rebase /path/to/source
node scripts/blg.mjs overlays /path/to/source
node scripts/blg.mjs adopt /path/to/source <overlay-filename>
node scripts/blg.mjs bind /path/to/source <repo-id>
node scripts/blg.mjs export /path/to/source /new/export-directory
```

For another device, clone the **data repository** separately and `bind` the source. After a branch rename or worktree move, list records and explicitly `adopt` one; the original is retained. Export excludes source, machine-local paths, and Git history.

## Model usage and privacy

- Clicking, zooming, expanding saved nodes, HTML rendering, and fingerprint checks do not invoke a model.
- Initialization, explanation, verification, and enrichment use a model. No fixed usage-saving percentage is promised.
- Focused context and read budgets avoid whole-map loading; a new commit does not require rereading every node.
- BLG itself does not upload source or graphs. Context sent by Codex follows the service and configuration you use.
- **Open-source tooling does not mean public business data.** This repository contains tooling, schemas, and synthetic examples only. Review real data archives and history before sharing.
- The CLI does not automatically configure remotes or push. Data commits, remote setup, and pushes require an explicit request.

## Layout and boundaries

```text
.codex-plugin/                  Codex plugin manifest
skills/business-logic-graph/     Agent workflow and verification policy
packages/protocol/              Graph / overlay / Patch JSON Schemas
packages/core/                  Validation, context, gates, storage, and Git checks
scripts/                        Node CLI and Windows CMD entrypoint
examples/order-demo/            Synthetic graph, source, configuration, and tests
apps/viewer/                    React Flow + ELK business-block UI
```

The local loop is implemented. `initialize / inspect / explain / plan / sync` are Skill-driven model workflows, not standalone CLI subcommands.

Next directions: a live CodeGraph adapter, richer stable symbol locators, dependency-aware verification, manual conflict UI, post-merge baseline synchronization, and visual business editing. The current business Viewer is primarily read-only.

## Contributing and license

Issues and PRs are welcome. Run `npm run check` before submitting. Do not commit customer source, real business maps, credentials, or machine-local paths.

BLG is licensed under [MIT](LICENSE). The Viewer originated from the MIT [CodeSee](https://github.com/Kaka-cheaper/codeSee) Viewer. Its license is preserved in [LICENSES/CodeSee-MIT.txt](LICENSES/CodeSee-MIT.txt); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). React Flow and ELK.js retain their respective licenses. CodeGraph is not a bundled dependency.

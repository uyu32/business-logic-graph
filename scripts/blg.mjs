#!/usr/bin/env node
import { watch, watchFile, unwatchFile } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  applyPatchEnvelope, buildContext, buildIndex, computeRepositorySnapshot,
  createPreviewServer, evaluatePlanGate, renderStandaloneViewer, validateGraph,
  initializeWorkspace, bindWorkspace, loadWorkspace, readWorkspaceSource,
  saveWorkspacePatch, rebaseWorkspace, commitWorkspace, exportWorkspace, inspectSource,
  listWorkspaceOverlays, adoptWorkspaceOverlay, assertExternalPath,
} from '../packages/core/src/index.mjs'

function usage() {
  return `Business Logic Graph CLI — independent data Git repositories

Usage:
  blg init <source-root> [--import graph.json] [--baseline master] [--repo-id ID]
  blg bind <source-root> <repo-id>
  blg status <source-root>
  blg validate <source-root|graph.json>
  blg index <source-root|graph.json>
  blg context <source-root|graph.json> <node-or-query> [--depth N] [--max-nodes N] [--max-chars N]
  blg source <source-root> <relative-path> [--start-line N] [--end-line N] [--max-chars N]
  blg gate <source-root|graph.json> <node-id> [node-id...]
  blg patch <source-root|graph.json> <patch.json> [--write] [--head COMMIT]
  blg rebase <source-root>
  blg overlays <source-root>
  blg adopt <source-root> <overlay-filename>
  blg commit <source-root> --message TEXT
  blg export <source-root> <new-directory>
  blg snapshot <source-root>
  blg render <source-root|graph.json> [output.html]
  blg preview <source-root> [--host HOST] [--port N] [--reuse] [--no-open] [--no-source-watch] [--no-build]

Workspace commands accept --data-root PATH (or BLG_DATA_HOME) and --scope baseline.
Default data root: <user-profile>/BLG/data. Source repositories are read-only.
init creates a separate local Git repository and its first data commit; never pushes.
patch is a dry run unless --write; file-path compatibility is read-only.
commit saves BLG data only, not source code. HTML and local bindings are not tracked.`
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''))
}

const VALUE_OPTIONS = new Set(['--data-root', '--baseline', '--repo-id', '--import', '--scope', '--depth', '--max-nodes', '--max-chars', '--head', '--message', '--host', '--port', '--start-line', '--end-line'])
const FLAG_OPTIONS = new Set(['--write', '--reuse', '--no-open', '--no-source-watch', '--no-build'])
function parseArgs(args) {
  const options = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (VALUE_OPTIONS.has(item)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${item} requires a value`)
      options[item] = args[++i]
    } else if (FLAG_OPTIONS.has(item)) options[item] = true
    else if (item.startsWith('--')) throw new Error(`Unknown option ${item}`)
    else positional.push(item)
  }
  if (options['--scope'] && options['--scope'] !== 'baseline') throw new Error('--scope only accepts baseline; default scope follows the current branch')
  return { options, positional }
}

function numberOption(options, name, fallback) {
  if (options[name] === undefined) return fallback
  const value = Number(options[name])
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

const workspaceOptions = (options) => ({ dataRoot: options['--data-root'], scope: options['--scope'] })
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
const pluginRoot = () => fileURLToPath(new URL('..', import.meta.url))

async function runViewerBuild(root, options) {
  if (options['--no-build']) return
  try { await stat(path.join(root, 'apps', 'viewer', 'node_modules')) } catch {
    await stat(path.join(root, 'apps', 'viewer', 'dist', 'index.html'))
    process.stdout.write('Using bundled compiled Viewer. To rebuild source, first run npm --prefix apps/viewer ci.\n')
    return
  }
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm --prefix apps/viewer run build'] : ['--prefix', path.join(root, 'apps', 'viewer'), 'run', 'build']
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Viewer build failed (${signal ?? code})`)))
  })
}

function openExternalBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}

async function runPreview(input, options) {
  const root = pluginRoot()
  const settings = workspaceOptions(options)
  let current = await loadWorkspace(input, settings)
  const host = options['--host'] ?? '127.0.0.1'
  const port = numberOption(options, '--port', 5182)
  if (port > 65535) throw new Error('--port must be between 0 and 65535')
  if (options['--reuse'] && port > 0) {
    try {
      const response = await fetch(`http://${host}:${port}/__blg/status`, { signal: AbortSignal.timeout(1000) })
      const metadata = await response.json()
      if (metadata.repoId === current.config.repoId && metadata.worktreeId === current.source.worktreeId) {
        const url = `http://${host}:${port}/viewer/index.html`
        process.stdout.write(`Reusing matching BLG preview: ${url}\n`)
        if (!options['--no-open']) openExternalBrowser(url)
        return
      }
    } catch { /* only a matching BLG server can be reused */ }
  }
  process.stdout.write('BLG preview: compiling Viewer...\n')
  await runViewerBuild(root, options)
  const viewerDist = path.join(root, 'apps', 'viewer', 'dist')
  await renderStandaloneViewer({ graph: current.graph, viewerDist, outputPath: current.outputPath })
  const preview = await createPreviewServer({ root: path.dirname(current.outputPath), entryPath: 'index.html', host, port, metadata: { repoId: current.config.repoId, worktreeId: current.source.worktreeId } })
  process.stdout.write(`BLG preview: ${preview.url}\nData Git repository: ${current.projectRoot}\nHTML: ${current.outputPath}\nWatching data, branch context and Viewer sources. Source and baseline are never rewritten. Ctrl+C to stop.\n`)
  const nativeWatchers = []
  const evidenceWatchers = new Map()
  let pendingBuild = false
  let timer
  let work = Promise.resolve()
  let stopped = false
  const contextKey = (source) => `${source.kind}|${source.branch}|${source.head}|${source.baselineHead}|${source.dirty}`
  let lastContext = contextKey(current.source)
  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`BLG preview error: ${message}\n`)
    preview.broadcast('build-error', { message })
  }
  function schedule(build = false) {
    if (stopped) return
    pendingBuild ||= build
    clearTimeout(timer)
    timer = setTimeout(() => {
      const shouldBuild = pendingBuild
      pendingBuild = false
      work = work.then(async () => {
        if (shouldBuild) await runViewerBuild(root, options)
        current = await loadWorkspace(input, settings)
        lastContext = contextKey(current.source)
        await renderStandaloneViewer({ graph: current.graph, viewerDist, outputPath: current.outputPath })
        syncEvidenceWatchers()
        preview.broadcast('reload', { graphRevision: current.graph.graphRevision, branch: current.source.branch })
        process.stdout.write(`Preview updated: ${current.source.branch ?? current.source.kind}, ${current.scope}, r${current.graph.graphRevision}\n`)
      }).catch(reportError)
    }, 180)
  }
  function syncEvidenceWatchers() {
    if (options['--no-source-watch']) return
    const desired = new Set()
    for (const evidence of Object.values(current.graph.evidence)) {
      if (!['source', 'config', 'test'].includes(evidence.kind)) continue
      const absolute = path.resolve(current.source.root, evidence.locator.path)
      const boundary = path.relative(current.source.root, absolute)
      if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) continue
      desired.add(absolute)
    }
    for (const [absolute, listener] of evidenceWatchers) {
      if (!desired.has(absolute)) { unwatchFile(absolute, listener); evidenceWatchers.delete(absolute) }
    }
    for (const absolute of desired) {
      if (evidenceWatchers.has(absolute)) continue
      const listener = (now, before) => {
        if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) schedule()
      }
      watchFile(absolute, { interval: 400 }, listener)
      evidenceWatchers.set(absolute, listener)
    }
  }
  nativeWatchers.push(watch(current.projectRoot, { recursive: true }, (_event, filename) => {
    const relative = String(filename ?? '').replaceAll('\\', '/')
    if (/^(baseline\/|overlays\/|history\/|repository\.json$)/.test(relative)) schedule()
  }))
  nativeWatchers.push(watch(path.join(root, 'apps', 'viewer', 'src'), { recursive: true }, () => schedule(true)))
  for (const file of ['index.html', 'package.json', 'vite.config.ts']) nativeWatchers.push(watch(path.join(root, 'apps', 'viewer', file), () => schedule(true)))
  syncEvidenceWatchers()
  let checking = false
  const contextTimer = setInterval(async () => {
    if (checking || stopped) return
    checking = true
    try {
      const source = await inspectSource(current.source.root, current.config.baselineRef)
      if (source.kind === 'git' && contextKey(source) !== lastContext) { lastContext = contextKey(source); schedule() }
    } catch (error) { reportError(error) } finally { checking = false }
  }, 900)
  if (!options['--no-open']) openExternalBrowser(preview.url)
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  stopped = true
  clearTimeout(timer)
  clearInterval(contextTimer)
  for (const watcher of nativeWatchers) watcher.close()
  for (const [absolute, listener] of evidenceWatchers) unwatchFile(absolute, listener)
  await work
  await preview.close()
}

async function main() {
  const [, , command, input, ...args] = process.argv
  if (!command || command === 'help' || command === '--help') { process.stdout.write(`${usage()}\n`); return }
  if (!input) throw new Error(`A source or graph path is required.\n${usage()}`)
  const { options, positional } = parseArgs(args)
  const settings = workspaceOptions(options)
  if (command === 'snapshot') { print(await computeRepositorySnapshot(input)); return }
  if (command === 'init') {
    const result = await initializeWorkspace(input, { ...settings, baselineRef: options['--baseline'], repoId: options['--repo-id'], importPath: options['--import'] })
    if (!result.existing) Object.assign(result, await commitWorkspace(input, 'Initialize independent BLG data repository', settings))
    print(result); return
  }
  if (command === 'bind') { print(await bindWorkspace(input, positional[0], settings)); return }
  if (command === 'overlays') { print(await listWorkspaceOverlays(input, settings)); return }
  if (command === 'adopt') { print(await adoptWorkspaceOverlay(input, positional[0], settings)); return }
  if (command === 'commit') { print(await commitWorkspace(input, options['--message'], settings)); return }
  if (command === 'export') {
    if (!positional[0]) throw new Error('export requires a new destination directory')
    print(await exportWorkspace(input, positional[0], settings)); return
  }
  if (command === 'rebase') {
    const result = await rebaseWorkspace(input, settings)
    print(result); if (!result.rebased) process.exitCode = 2; return
  }
  if (command === 'source') {
    if (!positional[0]) throw new Error('source requires a repository-relative file path')
    print(await readWorkspaceSource(input, positional[0], { ...settings, startLine: numberOption(options, '--start-line', 1), endLine: numberOption(options, '--end-line', undefined), maxChars: numberOption(options, '--max-chars', 24000) })); return
  }
  if (command === 'preview') { await runPreview(input, options); return }
  const directory = (await stat(input)).isDirectory()
  const workspace = directory ? await loadWorkspace(input, settings) : null
  const graph = workspace ? workspace.graph : await readJson(input)
  if (command === 'status') {
    if (!workspace) throw new Error('status requires a bound source directory')
    const { evidenceChecks, nodeChanges, conflicts, ...metadata } = workspace.view
    const checks = Object.values(evidenceChecks)
    const changes = Object.values(nodeChanges)
    print({ projectRoot: workspace.projectRoot, outputPath: workspace.outputPath, sourceRoot: workspace.source.root, sourceHead: graph.repository.head, graphRevision: graph.graphRevision, ...metadata,
      evidenceSummary: { checked: checks.length, unchanged: checks.filter(Boolean).length, stale: checks.filter((value) => !value).length },
      changeSummary: Object.fromEntries(['added', 'modified', 'deleted'].map((kind) => [kind, changes.filter((change) => change.kind === kind).length])),
      conflictCount: conflicts.length, conflicts: conflicts.slice(0, 12).map(({ path, message }) => ({ path, message })), conflictsTruncated: conflicts.length > 12,
    }); return
  }
  if (command === 'validate') {
    const result = validateGraph(graph); print(result); if (!result.valid) process.exitCode = 1; return
  }
  if (command === 'index') { print(buildIndex(graph)); return }
  if (command === 'context') {
    if (!positional[0]) throw new Error('context requires a node id or query')
    print(buildContext(graph, positional[0], { depth: numberOption(options, '--depth', 1), maxNodes: numberOption(options, '--max-nodes', 32), maxChars: numberOption(options, '--max-chars', 24000) })); return
  }
  if (command === 'gate') {
    if (!positional.length) throw new Error('gate requires affected node ids')
    const result = evaluatePlanGate(graph, positional); print(result); if (!result.ready) process.exitCode = 2; return
  }
  if (command === 'patch') {
    if (!positional[0]) throw new Error('patch requires a patch envelope path')
    const envelope = await readJson(positional[0])
    if (workspace) {
      if (options['--head'] && options['--head'] !== graph.repository.head) throw new Error('--head does not match the real source context')
      print(await saveWorkspacePatch(input, envelope, { ...settings, write: Boolean(options['--write']) }))
    } else {
      if (options['--write']) throw new Error('Direct graph-file writes are disabled. Use the bound source directory so BLG can route baseline/overlay writes safely.')
      const result = applyPatchEnvelope(graph, envelope, { currentHead: options['--head'] })
      print({ dryRun: true, graphRevision: result.graph.graphRevision, validation: result.validation })
    }
    return
  }
  if (command === 'render') {
    const validation = validateGraph(graph)
    if (!validation.valid) throw new Error(`Invalid graph: ${validation.errors[0].message}`)
    const outputPath = positional[0] ?? workspace?.outputPath
    if (!outputPath) throw new Error('Raw graph rendering requires an explicit output path; use a bound source directory for external default output')
    if (workspace) {
      await assertExternalPath(workspace.source.root, outputPath)
      const relative = path.relative(workspace.source.root, path.resolve(outputPath))
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('HTML output must be outside the target source repository')
    }
    print(await renderStandaloneViewer({ graph, viewerDist: path.join(pluginRoot(), 'apps', 'viewer', 'dist'), outputPath })); return
  }
  throw new Error(`Unknown command ${command}\n${usage()}`)
}

main().catch((error) => { process.stderr.write(`BLG error: ${error.message}\n`); process.exitCode = 1 })

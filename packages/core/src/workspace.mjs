import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, writeFile, rename, realpath, open, rm, readdir, cp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyPatchEnvelope } from './patch.mjs'
import { computeRepositorySnapshot } from './snapshot.mjs'
import { validateGraph } from './validate.mjs'

const run = promisify(execFile)
const MAPS = ['nodes', 'edges', 'claims', 'evidence', 'tours']
const sha = (value) => createHash('sha256').update(value).digest('hex')
const digest = (graph) => sha(JSON.stringify(graph))
const escapePointer = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1')
const unescapePointer = (value) => value.replaceAll('~1', '/').replaceAll('~0', '~')
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export function defaultDataRoot() {
  return path.resolve(process.env.BLG_DATA_HOME ?? path.join(os.homedir(), 'BLG', 'data'))
}

async function git(root, args, { optional = false, bytes = false } = {}) {
  try {
    const result = await run('git', ['-C', root, ...args], { encoding: bytes ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return bytes ? result.stdout : result.stdout.trim()
  } catch (error) {
    if (optional) return null
    throw new Error(`Git ${args[0]} failed: ${String(error.stderr ?? error.message).trim()}`)
  }
}

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
}

async function readOptional(file) {
  try { return await readJson(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}

async function locked(directory, action) {
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'write.lock')
  let handle
  try { handle = await open(file, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`BLG writer already active: ${file}. Recover a crash lock only after confirming no writer remains.`)
    throw error
  }
  try { return await action() } finally { await handle.close(); await rm(file, { force: true }) }
}

function assertId(id) {
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(id)) throw new Error('repo-id must be a stable lowercase directory-safe id')
}

function assertOutside(sourceRoot, destination) {
  const boundary = path.relative(sourceRoot, destination)
  if (!boundary || (!boundary.startsWith(`..${path.sep}`) && boundary !== '..' && !path.isAbsolute(boundary))) {
    throw new Error('BLG data must be outside the target source repository')
  }
}

async function resolvedDestination(destination) {
  try { return await realpath(destination) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(destination)
    if (parent === destination) throw error
    return path.join(await resolvedDestination(parent), path.basename(destination))
  }
}

export async function assertExternalPath(sourceRoot, destination) {
  assertOutside(await realpath(sourceRoot), await resolvedDestination(path.resolve(destination)))
}

async function assertManagedPaths(sourceRoot, projectRoot) {
  for (const name of ['', 'baseline', 'overlays', 'history', 'imports', '.local', 'viewer']) {
    await assertExternalPath(sourceRoot, path.join(projectRoot, name))
  }
}

export async function inspectSource(input, baselineRef = 'master') {
  const requested = await realpath(path.resolve(input))
  const top = await git(requested, ['rev-parse', '--show-toplevel'], { optional: true })
  if (!top) {
    return { kind: 'snapshot', root: requested, identity: requested, worktreeId: sha(requested).slice(0, 16), branch: null, head: null, baselineHead: null, dirty: false }
  }
  const root = await realpath(top)
  const commonDir = await realpath(path.resolve(root, await git(root, ['rev-parse', '--git-common-dir'])))
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { optional: true })
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { optional: true })
  if (!head) throw new Error('The source Git repository has no commit; commit source code before binding BLG')
  const baselineHead = await git(root, ['rev-parse', '--verify', `refs/heads/${baselineRef}^{commit}`], { optional: true })
  if (!baselineHead) throw new Error(`Baseline branch ${baselineRef} does not exist. Specify --baseline explicitly; BLG will not invent master.`)
  return {
    kind: 'git', root, identity: commonDir, commonDir,
    worktreeId: sha(root).slice(0, 16), branch, head, baselineHead,
    dirty: Boolean(await git(root, ['status', '--porcelain', '--untracked-files=normal'])),
  }
}

async function registryAt(dataRoot) {
  return await readOptional(path.join(dataRoot, 'registry.json')) ?? { schemaVersion: '0.1.0', bindings: [] }
}

async function locate(input, options = {}) {
  const dataRoot = await realpath(path.resolve(options.dataRoot ?? defaultDataRoot()))
  const registry = await registryAt(dataRoot)
  // Determine identity first; the binding decides which baseline branch to use.
  const requested = await realpath(path.resolve(input))
  const top = await git(requested, ['rev-parse', '--show-toplevel'], { optional: true })
  const root = top ? await realpath(top) : requested
  const identity = top ? await realpath(path.resolve(root, await git(root, ['rev-parse', '--git-common-dir']))) : root
  const binding = registry.bindings.find((item) => samePath(item.identity, identity))
  if (!binding) throw new Error(`No external BLG binding for ${root}. Run blg init <source-root> --import <old-graph.json>, or blg bind <source-root> <repo-id>.`)
  assertId(binding.repoId)
  const projectRoot = path.join(dataRoot, 'projects', binding.repoId)
  assertOutside(root, await realpath(projectRoot))
  await assertManagedPaths(root, projectRoot)
  const config = await readJson(path.join(projectRoot, 'repository.json'))
  const source = await inspectSource(root, config.baselineRef)
  if (source.kind === 'snapshot') source.head = source.baselineHead = (await computeRepositorySnapshot(root)).revision
  return { dataRoot, projectRoot, config, source, binding }
}

export async function bindWorkspace(input, repoId, options = {}) {
  assertId(repoId)
  const dataRoot = path.resolve(options.dataRoot ?? defaultDataRoot())
  const projectRoot = path.join(dataRoot, 'projects', repoId)
  const config = await readJson(path.join(projectRoot, 'repository.json'))
  const source = await inspectSource(input, config.baselineRef)
  assertOutside(source.root, await realpath(projectRoot))
  await assertManagedPaths(source.root, projectRoot)
  await locked(path.join(dataRoot, '.local'), async () => {
    const registry = await registryAt(dataRoot)
    const existing = registry.bindings.find((item) => samePath(item.identity, source.identity))
    if (existing && existing.repoId !== repoId) throw new Error('Source already bound to another BLG project')
    if (!existing) registry.bindings.push({ repoId, identity: source.identity, sourceRoot: source.root })
    await atomicJson(path.join(dataRoot, 'registry.json'), registry)
  })
  return { repoId, projectRoot, sourceKind: source.kind }
}

async function sourceBytes(source, locatorPath, scope) {
  const relative = locatorPath.replaceAll('\\', '/').replace(/^\.\//, '')
  const absolute = path.resolve(source.root, relative)
  const boundary = path.relative(source.root, absolute)
  if (!relative || boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary) || relative.startsWith('.git/')) throw new Error('Unsafe source evidence path')
  if (scope === 'baseline' && source.kind === 'git') {
    const bytes = await git(source.root, ['show', `${source.baselineHead}:${relative}`], { optional: true, bytes: true })
    if (!bytes) throw new Error(`Missing baseline source ${relative}`)
    return bytes
  }
  const resolved = await realpath(absolute)
  const realBoundary = path.relative(source.root, resolved)
  if (realBoundary === '..' || realBoundary.startsWith(`..${path.sep}`) || path.isAbsolute(realBoundary)) throw new Error('Evidence symlink escapes source repository')
  return readFile(resolved)
}

async function captureFingerprints(graph, source, scope) {
  const next = structuredClone(graph)
  delete next.view
  next.repository.root = '.'
  next.tours ??= {}
  for (const item of Object.values(next.evidence)) {
    if (!['source', 'config', 'test'].includes(item.kind) || item.verification.status !== 'verified' || item.verification.commit !== next.repository.head) continue
    const value = sha(await sourceBytes(source, item.locator.path, scope))
    if (item.fingerprint?.algorithm === 'sha256' && item.fingerprint.value !== value) throw new Error(`Evidence fingerprint mismatch: ${item.id}; read and reverify its source`)
    item.fingerprint = { algorithm: 'sha256', value }
  }
  return next
}

export async function initializeWorkspace(input, options = {}) {
  const baselineRef = options.baselineRef ?? 'master'
  const source = await inspectSource(input, baselineRef)
  const dataRoot = path.resolve(options.dataRoot ?? defaultDataRoot())
  assertOutside(source.root, dataRoot)
  await mkdir(dataRoot, { recursive: true })
  assertOutside(source.root, await realpath(dataRoot))
  await assertExternalPath(source.root, path.join(dataRoot, '.local'))
  return locked(path.join(dataRoot, '.local'), async () => {
    const registry = await registryAt(dataRoot)
    const existing = registry.bindings.find((item) => samePath(item.identity, source.identity))
    if (existing) return { existing: true, repoId: existing.repoId, projectRoot: path.join(dataRoot, 'projects', existing.repoId) }
    const slug = path.basename(source.root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repository'
    const repoId = options.repoId ?? `${slug}-${randomUUID().slice(0, 8)}`
    assertId(repoId)
    const projectRoot = path.join(dataRoot, 'projects', repoId)
    await assertManagedPaths(source.root, projectRoot)
    if (await readOptional(path.join(projectRoot, 'repository.json'))) throw new Error('BLG project already exists; use bind instead of overwriting it')
    try {
      if ((await readdir(projectRoot)).length) throw new Error('Refusing to initialize Git in a nonempty existing BLG directory')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (source.kind === 'snapshot') source.head = source.baselineHead = (await computeRepositorySnapshot(source.root)).revision
    const now = new Date().toISOString()
    let graph = options.importPath ? await readJson(options.importPath) : {
      schemaVersion: '0.1.0', graphId: repoId, graphRevision: 0, title: path.basename(source.root), updatedAt: now,
      repository: { root: '.', head: source.baselineHead, dirty: false }, nodes: {}, edges: {}, claims: {}, evidence: {}, tours: {},
    }
    const validation = validateGraph(graph)
    if (!validation.valid) throw new Error(`Invalid import: ${validation.errors[0].message}`)
    if (graph.repository.head !== source.baselineHead) throw new Error('Imported graph is not verified against the baseline source revision. Reverify it first; feature-branch facts cannot become master facts by import.')
    graph = await captureFingerprints(graph, source, 'baseline')
    await mkdir(projectRoot, { recursive: true })
    assertOutside(source.root, await realpath(projectRoot))
    // This Git repository contains only BLG data, never target source code.
    await git(projectRoot, ['init', '-b', 'blg-data'])
    await writeFile(path.join(projectRoot, '.gitignore'), '.local/\ncache/\nviewer/\n*.tmp\n', 'utf8')
    await atomicJson(path.join(projectRoot, 'repository.json'), { schemaVersion: '0.1.0', repoId, graphId: graph.graphId, baselineRef, sourceKind: source.kind })
    await atomicJson(path.join(projectRoot, 'baseline', 'graph.json'), graph)
    if (options.importPath) await atomicJson(path.join(projectRoot, 'imports', 'original-graph.json'), await readJson(options.importPath))
    await archiveGraph(projectRoot, graph)
    registry.bindings.push({ repoId, identity: source.identity, sourceRoot: source.root })
    await atomicJson(path.join(dataRoot, 'registry.json'), registry)
    return { repoId, projectRoot, baselinePath: path.join(projectRoot, 'baseline', 'graph.json'), sourceKind: source.kind, baselineRef, sourceHead: source.baselineHead, committed: false }
  })
}

async function archiveGraph(projectRoot, graph) {
  const id = digest(graph)
  await atomicJson(path.join(projectRoot, 'history', `${id}.json`), graph)
  return id
}

function graphOperations(base, next) {
  const operations = []
  for (const map of MAPS) {
    for (const id of new Set([...Object.keys(base[map] ?? {}), ...Object.keys(next[map] ?? {})])) {
      const before = base[map]?.[id]
      const after = next[map]?.[id]
      if (isDeepStrictEqual(before, after)) continue
      const pointer = `/${map}/${escapePointer(id)}`
      if (after === undefined) operations.push({ op: 'remove', path: pointer })
      else operations.push({ op: before === undefined ? 'add' : 'replace', path: pointer, value: after })
    }
  }
  if (!isDeepStrictEqual(base.title, next.title)) operations.push({ op: base.title === undefined ? 'add' : 'replace', path: '/title', value: next.title })
  return operations
}

function applyOperations(graph, operations) {
  if (!operations.length) return structuredClone(graph)
  return applyPatchEnvelope(graph, {
    schemaVersion: '0.1.0', baseGraphRevision: graph.graphRevision, repositoryHead: graph.repository.head,
    reason: 'Compose a persisted branch change set', operations,
  }).graph
}

export function mergeOverlay(base, latest, operations) {
  const applicable = []
  const conflicts = []
  for (const operation of operations) {
    const parts = operation.path.slice(1).split('/').map(unescapePointer)
    const valueAt = (graph) => parts.reduce((value, key) => value?.[key], graph)
    const before = valueAt(base)
    const current = valueAt(latest)
    const proposed = operation.op === 'remove' ? undefined : operation.value
    if (isDeepStrictEqual(current, proposed)) continue
    if (!isDeepStrictEqual(current, before)) conflicts.push({ path: operation.path, message: 'Master and branch changed the same entity', before, current, proposed })
    else applicable.push({ ...operation, op: proposed === undefined ? 'remove' : current === undefined ? 'add' : 'replace' })
  }
  try { return { graph: applyOperations(latest, applicable), conflicts } } catch (error) {
    return { graph: structuredClone(latest), conflicts: [...conflicts, { path: '', message: error.message }] }
  }
}

function semanticClaim(claim) {
  if (!claim) return claim
  const { verification: _verification, ...rest } = claim
  return rest
}

export function diffBusinessNodes(base, next) {
  const changes = {}
  for (const id of new Set([...Object.keys(base.nodes), ...Object.keys(next.nodes)])) {
    const before = base.nodes[id]
    const after = next.nodes[id]
    const previousClaims = Object.values(base.claims).filter((item) => item.nodeId === id).map(semanticClaim)
    const nextClaims = Object.values(next.claims).filter((item) => item.nodeId === id).map(semanticClaim)
    if (isDeepStrictEqual(before, after) && isDeepStrictEqual(previousClaims, nextClaims)) continue
    changes[id] = { kind: !before ? 'added' : !after ? 'deleted' : 'modified', before, after, beforeClaims: previousClaims.map((item) => item.statement), afterClaims: nextClaims.map((item) => item.statement) }
  }
  return changes
}

async function checkEvidence(graph, source, scope) {
  const next = structuredClone(graph)
  const evidenceChecks = {}
  for (const item of Object.values(next.evidence)) {
    if (!['source', 'config', 'test'].includes(item.kind) || item.verification.status !== 'verified') continue
    try {
      const current = await sourceBytes(source, item.locator.path, scope)
      let expected = item.fingerprint?.algorithm === 'sha256' ? item.fingerprint.value : null
      if (!expected && source.kind === 'git' && item.verification.commit === next.repository.head) {
        const committed = await git(source.root, ['show', `${next.repository.head}:${item.locator.path.replaceAll('\\', '/')}`], { optional: true, bytes: true })
        if (committed) expected = sha(committed)
      }
      evidenceChecks[item.id] = expected ? sha(current) === expected : item.verification.commit === next.repository.head && source.kind === 'snapshot'
    } catch { evidenceChecks[item.id] = false }
    if (!evidenceChecks[item.id]) item.verification.status = 'stale'
  }
  for (const claim of Object.values(next.claims)) {
    if (claim.verification.status === 'user-confirmed') continue
    if (claim.evidenceIds.some((id) => evidenceChecks[id] === false)) claim.verification.status = 'stale'
  }
  return { graph: next, evidenceChecks }
}

export async function loadWorkspace(input, options = {}) {
  const workspace = await locate(input, options)
  const { projectRoot, source, config } = workspace
  const baseline = await readJson(path.join(projectRoot, 'baseline', 'graph.json'))
  const validation = validateGraph(baseline)
  if (!validation.valid) throw new Error(`Invalid baseline graph: ${validation.errors[0].message}`)
  const scope = options.scope === 'baseline' || source.kind === 'snapshot' || source.branch === config.baselineRef ? 'baseline' : 'branch'
  const scopeKey = sha(`${source.worktreeId}\0${source.branch ?? source.head}`).slice(0, 32)
  const overlayPath = path.join(projectRoot, 'overlays', `${scopeKey}.json`)
  const overlay = scope === 'branch' ? await readOptional(overlayPath) : null
  let rawGraph = structuredClone(baseline)
  let base = baseline
  let conflicts = []
  const baselineAdvanced = Boolean(overlay && overlay.baseGraphDigest !== digest(baseline))
  if (overlay) {
    if (overlay.schemaVersion !== '0.1.0' || !Number.isInteger(overlay.revision) || overlay.revision < 1 || !Number.isInteger(overlay.graphRevision) || !Array.isArray(overlay.operations)) throw new Error('Invalid branch overlay metadata')
    if (overlay.worktreeId !== source.worktreeId || overlay.branch !== source.branch || overlay.baselineRef !== config.baselineRef) throw new Error('Overlay belongs to another branch/worktree context')
    for (const operation of overlay.operations) {
      if (!['add', 'replace', 'remove'].includes(operation.op) || !/^\/(title|(nodes|edges|claims|evidence|tours)\/[^/]+)$/.test(operation.path)) throw new Error('Invalid persisted overlay operation; managed context cannot be patched')
    }
    if (!/^[a-f0-9]{64}$/.test(overlay.baseGraphDigest)) throw new Error('Invalid overlay base digest')
    base = await readJson(path.join(projectRoot, 'history', `${overlay.baseGraphDigest}.json`))
    if (digest(base) !== overlay.baseGraphDigest) throw new Error('Overlay base snapshot digest mismatch')
    const composed = mergeOverlay(base, baseline, overlay.operations)
    rawGraph = composed.graph
    conflicts = composed.conflicts
    rawGraph.graphRevision = overlay.graphRevision
    rawGraph.updatedAt = overlay.updatedAt
  }
  rawGraph.repository = { ...rawGraph.repository, root: '.', head: scope === 'baseline' ? source.baselineHead : source.head, dirty: scope === 'branch' && source.dirty }
  const checked = await checkEvidence(rawGraph, source, scope)
  const view = {
    repoId: config.repoId, scope, baselineRef: config.baselineRef,
    baselineSourceHead: source.baselineHead, recordedBaselineHead: baseline.repository.head,
    baselineGraphRevision: baseline.graphRevision, sourceKind: source.kind,
    sourceBranch: source.branch, worktreeId: source.worktreeId,
    overlayId: overlay?.id ?? null, overlayRevision: overlay?.revision ?? 0,
    baselineAdvanced, conflicts, evidenceChecks: checked.evidenceChecks,
    nodeChanges: scope === 'branch' ? diffBusinessNodes(baseline, rawGraph) : {},
  }
  checked.graph.view = view
  return { ...workspace, scope, scopeKey, overlayPath, overlay, baseline, base, rawGraph, graph: checked.graph, view, outputPath: path.join(projectRoot, 'viewer', source.worktreeId, 'index.html') }
}

export async function readWorkspaceSource(input, relativePath, options = {}) {
  const workspace = await locate(input, options)
  const scope = options.scope === 'baseline' || workspace.source.kind === 'snapshot' || workspace.source.branch === workspace.config.baselineRef ? 'baseline' : 'branch'
  const bytes = await sourceBytes(workspace.source, relativePath, scope)
  const lines = bytes.toString('utf8').split('\n')
  const start = options.startLine ?? 1
  const end = Math.min(options.endLine ?? lines.length, lines.length)
  if (start < 1 || end < start) throw new Error('Invalid source line range')
  const maxChars = options.maxChars ?? 24000
  let content = ''
  let lastLine = start - 1
  for (let i = start - 1; i < end; i++) {
    const text = `${i + 1}: ${lines[i]}\n`
    if (content.length + text.length > maxChars) break
    content += text
    lastLine = i + 1
  }
  if (lastLine < start) throw new Error('One source line exceeds the requested character budget; increase --max-chars explicitly')
  return { scope, sourceHead: scope === 'baseline' ? workspace.source.baselineHead : workspace.source.head, fingerprint: { algorithm: 'sha256', value: sha(bytes) }, path: relativePath, startLine: start, endLine: lastLine, truncated: lastLine < end, content }
}

function assertSourceUnchanged(previous, current) {
  if (previous.source.head !== current.source.head || previous.source.baselineHead !== current.source.baselineHead || previous.source.branch !== current.source.branch) throw new Error('Source branch or commit changed during BLG operation; retry against the new context')
  if (digest(previous.baseline) !== digest(current.baseline) || previous.overlay?.revision !== current.overlay?.revision) throw new Error('BLG changed concurrently; reload the graph revision')
}

export async function saveWorkspacePatch(input, envelope, options = {}) {
  const loaded = await loadWorkspace(input, options)
  return locked(path.join(loaded.projectRoot, '.local'), async () => {
    const current = await loadWorkspace(input, options)
    assertSourceUnchanged(loaded, current)
    if (current.view.baselineAdvanced) throw new Error('Master graph advanced; run blg rebase before updating this change set')
    if (current.scope === 'baseline' && current.source.kind === 'git' && (current.source.branch !== current.config.baselineRef || current.source.dirty)) throw new Error('Baseline writes require a clean checkout of the baseline branch. Use its dedicated worktree; feature worktrees write overlays only.')
    for (const operation of envelope.operations ?? []) {
      if (['/repository', '/view', '/schemaVersion', '/graphId'].some((prefix) => operation.path === prefix || operation.path?.startsWith(`${prefix}/`) || operation.from === prefix || operation.from?.startsWith(`${prefix}/`))) throw new Error('Repository context and view metadata are managed by BLG')
    }
    const patchGraph = structuredClone(current.graph)
    delete patchGraph.view
    const result = applyPatchEnvelope(patchGraph, envelope, { currentHead: current.rawGraph.repository.head })
    const next = await captureFingerprints(result.graph, current.source, current.scope)
    const rechecked = await checkEvidence(next, current.source, current.scope)
    for (const item of Object.values(next.evidence)) {
      if (item.verification.status === 'verified' && rechecked.evidenceChecks[item.id] === false) throw new Error(`Verified evidence ${item.id} does not match the current source; reverify before saving`)
    }
    const after = await inspectSource(current.source.root, current.config.baselineRef)
    if (after.kind === 'snapshot') after.head = after.baselineHead = (await computeRepositorySnapshot(after.root)).revision
    assertSourceUnchanged(current, { ...current, source: after })
    if (options.write === false) return { dryRun: true, scope: current.scope, graphRevision: next.graphRevision, validation: result.validation }
    await archiveGraph(current.projectRoot, current.baseline)
    if (current.scope === 'baseline') {
      await archiveGraph(current.projectRoot, next)
      await atomicJson(path.join(current.projectRoot, 'baseline', 'graph.json'), next)
    } else {
      const overlay = {
        schemaVersion: '0.1.0', id: current.overlay?.id ?? randomUUID(), revision: (current.overlay?.revision ?? 0) + 1,
        baselineRef: current.config.baselineRef, baseSourceCommit: current.baseline.repository.head,
        baseGraphRevision: current.baseline.graphRevision, baseGraphDigest: digest(current.baseline),
        branch: current.source.branch, worktreeId: current.source.worktreeId, sourceHead: current.source.head,
        graphRevision: next.graphRevision, updatedAt: next.updatedAt, reason: envelope.reason,
        operations: graphOperations(current.baseline, next),
      }
      await atomicJson(current.overlayPath, overlay)
    }
    return { written: current.scope === 'baseline' ? path.join(current.projectRoot, 'baseline', 'graph.json') : current.overlayPath, scope: current.scope, graphRevision: next.graphRevision, appliedOperations: result.appliedOperations }
  })
}

export async function rebaseWorkspace(input, options = {}) {
  const loaded = await loadWorkspace(input, options)
  return locked(path.join(loaded.projectRoot, '.local'), async () => {
    const current = await loadWorkspace(input, options)
    assertSourceUnchanged(loaded, current)
    if (!current.overlay) throw new Error('No branch overlay to rebase')
    if (current.view.conflicts.length) return { rebased: false, conflicts: current.view.conflicts }
    const overlay = { ...current.overlay, revision: current.overlay.revision + 1,
      baseGraphDigest: await archiveGraph(current.projectRoot, current.baseline), baseGraphRevision: current.baseline.graphRevision,
      baseSourceCommit: current.baseline.repository.head, operations: graphOperations(current.baseline, current.rawGraph),
      graphRevision: Math.max(current.rawGraph.graphRevision, current.baseline.graphRevision) + 1, updatedAt: new Date().toISOString(),
    }
    await atomicJson(current.overlayPath, overlay)
    return { rebased: true, overlayId: overlay.id, overlayRevision: overlay.revision }
  })
}

export async function listWorkspaceOverlays(input, options = {}) {
  const workspace = await locate(input, options)
  let files
  try { files = await readdir(path.join(workspace.projectRoot, 'overlays')) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return Promise.all(files.filter((file) => /^[a-f0-9]{32}\.json$/.test(file)).map(async (file) => {
    const overlay = await readJson(path.join(workspace.projectRoot, 'overlays', file))
    return { file, id: overlay.id, branch: overlay.branch, worktreeId: overlay.worktreeId, revision: overlay.revision, sourceHead: overlay.sourceHead }
  }))
}

export async function adoptWorkspaceOverlay(input, filename, options = {}) {
  if (!/^[a-f0-9]{32}\.json$/.test(filename ?? '')) throw new Error('Select an overlay filename from blg overlays; arbitrary paths are not accepted')
  const loaded = await loadWorkspace(input, options)
  return locked(path.join(loaded.projectRoot, '.local'), async () => {
    const current = await loadWorkspace(input, options)
    assertSourceUnchanged(loaded, current)
    if (current.scope !== 'branch') throw new Error('Adopt overlays from a development worktree, not master or a ZIP snapshot')
    if (current.overlay) throw new Error('Current worktree already has an overlay; it will not be overwritten')
    const selected = await readJson(path.join(current.projectRoot, 'overlays', filename))
    if (selected.baselineRef !== current.config.baselineRef) throw new Error('Overlay baseline branch does not match this project')
    const adopted = { ...selected, branch: current.source.branch, worktreeId: current.source.worktreeId,
      sourceHead: current.source.head, revision: selected.revision + 1, updatedAt: new Date().toISOString(),
    }
    await atomicJson(current.overlayPath, adopted)
    return { adopted: true, overlayId: adopted.id, written: current.overlayPath, note: 'Original overlay preserved; inspect and reverify current source before planning' }
  })
}

export async function commitWorkspace(input, message, options = {}) {
  if (!message?.trim()) throw new Error('A commit message is required')
  const workspace = await locate(input, options)
  return locked(path.join(workspace.projectRoot, '.local'), async () => {
    const top = await git(workspace.projectRoot, ['rev-parse', '--show-toplevel'])
    if (!samePath(await realpath(top), await realpath(workspace.projectRoot))) throw new Error('BLG data must have its own Git repository')
    const entries = await readdir(workspace.projectRoot)
    const managed = ['.gitignore', 'repository.json', 'baseline', 'overlays', 'history', 'imports'].filter((name) => entries.includes(name))
    // Do not commit unrelated staged files, generated HTML, source code or local bindings.
    const staged = await git(workspace.projectRoot, ['diff', '--cached', '--name-only'])
    if (staged && staged.split('\n').some((name) => !managed.some((entry) => name === entry || name.startsWith(`${entry}/`)))) throw new Error('Unrelated staged files in BLG data repository; leave them untouched and commit them separately')
    await git(workspace.projectRoot, ['add', '-A', '--', ...managed])
    if (!await git(workspace.projectRoot, ['diff', '--cached', '--name-only'])) return { committed: false, reason: 'No BLG data changes', projectRoot: workspace.projectRoot }
    const name = await git(workspace.projectRoot, ['config', 'user.name'], { optional: true })
    const email = await git(workspace.projectRoot, ['config', 'user.email'], { optional: true })
    const identity = [...(!name ? ['-c', 'user.name=Business Logic Graph'] : []), ...(!email ? ['-c', 'user.email=blg@localhost'] : [])]
    await git(workspace.projectRoot, [...identity, 'commit', '-m', message])
    return { committed: true, dataCommit: await git(workspace.projectRoot, ['rev-parse', 'HEAD']), projectRoot: workspace.projectRoot }
  })
}

export async function exportWorkspace(input, destination, options = {}) {
  const workspace = await locate(input, options)
  const target = path.resolve(destination)
  assertOutside(workspace.projectRoot, target)
  await assertExternalPath(workspace.source.root, target)
  await mkdir(target, { recursive: false }) // never overwrite an existing export
  const entries = await readdir(workspace.projectRoot)
  for (const name of ['.gitignore', 'repository.json', 'baseline', 'overlays', 'history', 'imports'].filter((item) => entries.includes(item))) {
    await cp(path.join(workspace.projectRoot, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false })
  }
  return { exported: target, repoId: workspace.config.repoId, note: 'Source code and local paths are excluded. Clone the separate data Git repository to preserve commit history.' }
}

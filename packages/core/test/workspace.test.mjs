import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, cp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  initializeWorkspace, loadWorkspace, saveWorkspacePatch, bindWorkspace,
  commitWorkspace, rebaseWorkspace, exportWorkspace, readWorkspaceSource,
  evaluatePlanGate, buildContext, validateGraph, createPreviewServer,
  listWorkspaceOverlays, adoptWorkspaceOverlay,
} from '../src/index.mjs'

const exec = promisify(execFile)
async function git(root, ...args) {
  return (await exec('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim()
}
async function sourceCommit(root, message) {
  await git(root, 'add', '--', 'src')
  await git(root, '-c', 'user.name=BLG Test', '-c', 'user.email=blg-test@localhost', 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}
async function environment(t, { snapshot = false, locked = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'blg-workspace-'))
  // Only the exact test-owned mkdtemp directory is recursively removed.
  assert.equal(path.dirname(temporary), os.tmpdir())
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const source = path.join(temporary, 'source')
  const dataRoot = path.join(temporary, 'data')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await writeFile(path.join(source, 'src', 'main.ts'), 'export function acceptMember() {\n  return true\n}\n')
  let head
  if (!snapshot) {
    await git(source, 'init', '-b', 'master')
    await git(source, 'config', 'core.autocrlf', 'false')
    head = await sourceCommit(source, 'Source baseline')
  } else {
    const { computeRepositorySnapshot } = await import('../src/index.mjs')
    head = (await computeRepositorySnapshot(source)).revision
  }
  const graph = {
    schemaVersion: '0.1.0', graphId: 'test-business', graphRevision: 1, title: 'Test business',
    repository: { root: '.', head, dirty: false },
    nodes: {
      root: { id: 'root', type: 'business-flow', parentId: null, title: '组织与成员', summary: '组织业务', claimIds: [] },
      member: { id: 'member', type: 'business-rule', parentId: 'root', title: '成员准入', summary: '检查成员是否可以加入', claimIds: ['claim-member'] },
    }, edges: {},
    claims: { 'claim-member': { id: 'claim-member', nodeId: 'member', kind: 'code-fact', statement: '成员允许加入', evidenceIds: ['ev-member'], planGate: 'required', locked, verification: { status: 'verified', commit: head, confidence: 1 } } },
    evidence: { 'ev-member': { id: 'ev-member', kind: 'source', provider: 'repository', locator: { path: 'src/main.ts', symbol: 'acceptMember' }, claimIds: ['claim-member'], verification: { status: 'verified', commit: head } } }, tours: {},
  }
  const importPath = path.join(temporary, 'import.json')
  await writeFile(importPath, JSON.stringify(graph))
  const created = await initializeWorkspace(source, { dataRoot, importPath })
  return { temporary, source, dataRoot, head, graph, created, options: { dataRoot } }
}
const patchFor = (workspace, operations) => ({ schemaVersion: '0.1.0', baseGraphRevision: workspace.graph.graphRevision, repositoryHead: workspace.graph.repository.head, reason: 'Test business update', operations })

test('initializes a separate data Git repository without touching source; commits managed data only', async (t) => {
  const env = await environment(t)
  assert.equal(await git(env.source, 'status', '--porcelain'), '')
  await assert.rejects(stat(path.join(env.source, '.business-logic')), { code: 'ENOENT' })
  assert.notEqual(await git(env.source, 'rev-parse', '--show-toplevel'), await git(env.created.projectRoot, 'rev-parse', '--show-toplevel'))
  const saved = await commitWorkspace(env.source, 'Initial BLG data', env.options)
  assert.equal(saved.committed, true)
  assert.equal(await git(env.created.projectRoot, 'status', '--porcelain'), '')
  const files = await git(env.created.projectRoot, 'ls-files')
  assert.match(files, /baseline\/graph.json/)
  assert.doesNotMatch(files, /registry|viewer|\.local|src\//)
  assert.equal((await loadWorkspace(env.source, env.options)).view.evidenceChecks['ev-member'], true)
  const repeated = await initializeWorkspace(env.source, { ...env.options, importPath: env.temporary + '/missing.json' })
  assert.equal(repeated.existing, true)
})

test('branch additions, modifications and deletion ghosts persist externally through branch switching', async (t) => {
  const env = await environment(t)
  const original = await readFile(env.created.baselinePath, 'utf8')
  await git(env.source, 'switch', '-c', 'feature/member')
  const loaded = await loadWorkspace(env.source, env.options)
  const operations = [
    { op: 'replace', path: '/nodes/root/summary', value: '分支修改了组织业务' },
    { op: 'add', path: '/nodes/new-rule', value: { id: 'new-rule', type: 'business-rule', parentId: 'root', title: '分支新增规则', summary: '新规则', claimIds: [] } },
    { op: 'remove', path: '/nodes/member' },
    { op: 'remove', path: '/claims/claim-member' },
    { op: 'remove', path: '/evidence/ev-member' },
  ]
  assert.equal((await saveWorkspacePatch(env.source, patchFor(loaded, operations), { ...env.options, write: false })).dryRun, true)
  assert.equal((await loadWorkspace(env.source, env.options)).overlay, null)
  const result = await saveWorkspacePatch(env.source, patchFor(loaded, operations), env.options)
  assert.equal(result.scope, 'branch')
  const branch = await loadWorkspace(env.source, env.options)
  assert.equal(branch.view.nodeChanges.root.kind, 'modified')
  assert.equal(branch.view.nodeChanges['new-rule'].kind, 'added')
  assert.equal(branch.view.nodeChanges.member.kind, 'deleted')
  assert.equal(branch.graph.nodes.member, undefined)
  assert.equal(validateGraph(branch.graph).valid, true)
  assert.equal(await readFile(env.created.baselinePath, 'utf8'), original)
  await assert.rejects(saveWorkspacePatch(env.source, patchFor(loaded, operations), env.options), /Stale graph revision/)
  await git(env.source, 'switch', 'master')
  const master = await loadWorkspace(env.source, env.options)
  assert.equal(master.scope, 'baseline')
  assert.equal(master.graph.nodes['new-rule'], undefined)
  assert.equal(master.graph.nodes.member.title, '成员准入')
  await git(env.source, 'switch', 'feature/member')
  assert.equal((await loadWorkspace(env.source, env.options)).overlay.id, branch.overlay.id)
  assert.equal(await git(env.source, 'status', '--porcelain'), '')
})

test('worktrees share baseline identity but isolate branch overlays', async (t) => {
  const env = await environment(t)
  const other = path.join(env.temporary, 'other-worktree')
  await git(env.source, 'worktree', 'add', '-b', 'feature/other', other)
  const otherGraph = await loadWorkspace(other, env.options)
  assert.equal(otherGraph.config.repoId, env.created.repoId)
  const sourceGraph = await loadWorkspace(env.source, env.options)
  assert.notEqual(otherGraph.source.worktreeId, sourceGraph.source.worktreeId)
  await saveWorkspacePatch(other, patchFor(otherGraph, [{ op: 'replace', path: '/nodes/member/summary', value: 'other branch change' }]), env.options)
  await git(env.source, 'switch', '-c', 'feature/local')
  assert.equal((await loadWorkspace(env.source, env.options)).overlay, null)
  assert.equal((await loadWorkspace(other, env.options)).graph.nodes.member.summary, 'other branch change')
  await assert.rejects(stat(path.join(other, '.business-logic')), { code: 'ENOENT' })
})

test('baseline writes require clean master checkout, not feature code or dirty master', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/member')
  const baselineView = await loadWorkspace(env.source, { ...env.options, scope: 'baseline' })
  await assert.rejects(saveWorkspacePatch(env.source, patchFor(baselineView, [{ op: 'replace', path: '/nodes/root/summary', value: 'bad baseline update' }]), { ...env.options, scope: 'baseline' }), /clean checkout/)
  await git(env.source, 'switch', 'master')
  await writeFile(path.join(env.source, 'src', 'main.ts'), 'export const draft = true\n')
  const dirty = await loadWorkspace(env.source, env.options)
  await assert.rejects(saveWorkspacePatch(env.source, patchFor(dirty, [{ op: 'replace', path: '/nodes/root/summary', value: 'dirty source' }]), env.options), /clean checkout/)
})

test('unchanged fingerprint evidence is reusable at a new commit; changed source becomes stale without data writes', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/unrelated')
  await writeFile(path.join(env.source, 'src', 'unrelated.ts'), 'export const unrelated = 1\n')
  await sourceCommit(env.source, 'Unrelated change')
  const loaded = await loadWorkspace(env.source, env.options)
  assert.notEqual(loaded.graph.repository.head, env.head)
  assert.equal(loaded.graph.claims['claim-member'].verification.commit, env.head)
  assert.equal(evaluatePlanGate(loaded.graph, ['member']).ready, true)
  const original = await readFile(env.created.baselinePath, 'utf8')
  await writeFile(path.join(env.source, 'src', 'main.ts'), 'export function acceptMember() { return false }\n')
  const changed = await loadWorkspace(env.source, env.options)
  assert.equal(changed.graph.evidence['ev-member'].verification.status, 'stale')
  assert.equal(evaluatePlanGate(changed.graph, ['member']).ready, false)
  assert.equal(await readFile(env.created.baselinePath, 'utf8'), original)
  assert.equal(changed.overlay, null)
})

test('master movement blocks the gate until an explicit conflict-free three-way rebase', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/member')
  let loaded = await loadWorkspace(env.source, env.options)
  await saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/nodes/member/summary', value: 'feature member explanation' }]), env.options)
  await git(env.source, 'switch', 'master')
  loaded = await loadWorkspace(env.source, env.options)
  await saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/nodes/root/summary', value: 'master explanation improved' }]), env.options)
  await git(env.source, 'switch', 'feature/member')
  loaded = await loadWorkspace(env.source, env.options)
  assert.equal(loaded.view.baselineAdvanced, true)
  assert.equal(loaded.view.conflicts.length, 0)
  assert.equal(evaluatePlanGate(loaded.graph, ['member']).ready, false)
  assert.equal((await rebaseWorkspace(env.source, env.options)).rebased, true)
  loaded = await loadWorkspace(env.source, env.options)
  assert.equal(loaded.view.baselineAdvanced, false)
  assert.equal(loaded.graph.nodes.root.summary, 'master explanation improved')
  assert.equal(loaded.graph.nodes.member.summary, 'feature member explanation')
  assert.equal(evaluatePlanGate(loaded.graph, ['member']).ready, true)
})

test('conflicting master/branch entity edits are never silently applied or rebased', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/member')
  let loaded = await loadWorkspace(env.source, env.options)
  await saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/nodes/member/summary', value: 'feature interpretation' }]), env.options)
  await git(env.source, 'switch', 'master')
  loaded = await loadWorkspace(env.source, env.options)
  await saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/nodes/member/summary', value: 'master interpretation' }]), env.options)
  await git(env.source, 'switch', 'feature/member')
  const conflict = await loadWorkspace(env.source, env.options)
  assert.equal(conflict.view.conflicts[0].path, '/nodes/member')
  assert.equal(conflict.graph.nodes.member.summary, 'master interpretation')
  assert.equal((await rebaseWorkspace(env.source, env.options)).rebased, false)
  assert.equal(evaluatePlanGate(conflict.graph, ['member']).ready, false)
})

test('external writes retain user locks and protect managed context', async (t) => {
  const env = await environment(t, { locked: true })
  await git(env.source, 'switch', '-c', 'feature/member')
  const loaded = await loadWorkspace(env.source, env.options)
  await assert.rejects(saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/claims/claim-member/statement', value: 'overwrite confirmation' }]), env.options), /locked/)
  await assert.rejects(saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/repository/head', value: 'fake' }]), env.options), /managed by BLG/)
})

test('snapshot fallback creates Git for data only and detects source changes', async (t) => {
  const env = await environment(t, { snapshot: true })
  const initial = await loadWorkspace(env.source, env.options)
  assert.equal(initial.source.kind, 'snapshot')
  assert.equal(evaluatePlanGate(initial.graph, ['member']).ready, true)
  await assert.rejects(stat(path.join(env.source, '.git')), { code: 'ENOENT' })
  await writeFile(path.join(env.source, 'src', 'main.ts'), 'export const changed = true\n')
  const changed = await loadWorkspace(env.source, env.options)
  assert.equal(evaluatePlanGate(changed.graph, ['member']).ready, false)
  await assert.rejects(stat(path.join(env.source, '.git')), { code: 'ENOENT' })
})

test('source reads respect baseline vs worktree scope and enforce path and character boundaries', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/member')
  await writeFile(path.join(env.source, 'src', 'main.ts'), 'export const worktreeOnly = true\n')
  const baseline = await readWorkspaceSource(env.source, 'src/main.ts', { ...env.options, scope: 'baseline' })
  const branch = await readWorkspaceSource(env.source, 'src/main.ts', env.options)
  assert.match(baseline.content, /acceptMember/)
  assert.match(branch.content, /worktreeOnly/)
  await assert.rejects(readWorkspaceSource(env.source, '../import.json', env.options), /Unsafe/)
  await assert.rejects(readWorkspaceSource(env.source, 'src/main.ts', { ...env.options, maxChars: 5 }), /exceeds/)
})

test('context packets have a strict serialized character budget, without dropping focused evidence', async (t) => {
  const env = await environment(t)
  const loaded = await loadWorkspace(env.source, env.options)
  const packet = buildContext(loaded.graph, 'member', { maxChars: 6000 })
  assert.ok(JSON.stringify(packet, null, 2).length + 1 <= 6000)
  assert.equal(packet.scope.repoId, env.created.repoId)
  assert.ok(packet.evidence['ev-member'])
  assert.throws(() => buildContext(loaded.graph, 'member', { maxChars: 256 }), /evidence exceed/)
  assert.throws(() => buildContext(loaded.graph, 'member', { maxNodes: 1 }), /Ancestor path/)
})

test('data export and rebinding a cloned data repository do not copy source or local paths', async (t) => {
  const env = await environment(t)
  const target = path.join(env.temporary, 'exported')
  assert.equal((await exportWorkspace(env.source, target, env.options)).repoId, env.created.repoId)
  await assert.rejects(stat(path.join(target, '.git')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(target, 'src')), { code: 'ENOENT' })
  await assert.rejects(exportWorkspace(env.source, target, env.options), { code: 'EEXIST' })
  await commitWorkspace(env.source, 'Initial data', env.options)
  const newData = path.join(env.temporary, 'new-data')
  const clonedProject = path.join(newData, 'projects', env.created.repoId)
  await mkdir(path.dirname(clonedProject), { recursive: true })
  await git(env.temporary, 'clone', env.created.projectRoot, clonedProject)
  await bindWorkspace(env.source, env.created.repoId, { dataRoot: newData })
  assert.equal((await loadWorkspace(env.source, { dataRoot: newData })).config.repoId, env.created.repoId)
  assert.equal(await git(env.source, 'status', '--porcelain'), '')
})

test('explicit overlay adoption survives branch rename or a new worktree, retaining the original record', async (t) => {
  const env = await environment(t)
  await git(env.source, 'switch', '-c', 'feature/old')
  const loaded = await loadWorkspace(env.source, env.options)
  await saveWorkspacePatch(env.source, patchFor(loaded, [{ op: 'replace', path: '/nodes/member/summary', value: 'portable business update' }]), env.options)
  const records = await listWorkspaceOverlays(env.source, env.options)
  assert.equal(records.length, 1)
  await git(env.source, 'branch', '-m', 'feature/new')
  assert.equal((await loadWorkspace(env.source, env.options)).overlay, null)
  const adopted = await adoptWorkspaceOverlay(env.source, records[0].file, env.options)
  assert.equal(adopted.overlayId, records[0].id)
  assert.equal((await loadWorkspace(env.source, env.options)).graph.nodes.member.summary, 'portable business update')
  assert.equal((await listWorkspaceOverlays(env.source, env.options)).length, 2)
  await assert.rejects(adoptWorkspaceOverlay(env.source, records[0].file, env.options), /already has an overlay/)
})

test('refuses source-local storage, wrong-revision imports and unrelated staged data', async (t) => {
  const env = await environment(t)
  await assert.rejects(initializeWorkspace(env.source, { dataRoot: path.join(env.source, 'blg-data') }), /outside/)
  const secondSource = path.join(env.temporary, 'second-source')
  await cp(env.source, secondSource, { recursive: true })
  const wrong = path.join(env.temporary, 'wrong.json')
  await writeFile(wrong, JSON.stringify({ ...env.graph, repository: { root: '.', head: 'wrong-head' } }))
  await assert.rejects(initializeWorkspace(secondSource, { ...env.options, importPath: wrong }), /baseline source revision/)
  await writeFile(path.join(env.created.projectRoot, 'unrelated.txt'), 'unrelated')
  await git(env.created.projectRoot, 'add', '--', 'unrelated.txt')
  await assert.rejects(commitWorkspace(env.source, 'Do not include unrelated files', env.options), /Unrelated staged/)
})

test('preview can serve only generated HTML, not the separate Git database', async (t) => {
  const env = await environment(t)
  const root = path.join(env.created.projectRoot, 'viewer', 'test')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'index.html'), '<html><body>External BLG</body></html>')
  const server = await createPreviewServer({ root, entryPath: 'index.html', port: 0 })
  t.after(() => server.close())
  assert.equal((await fetch(server.url)).status, 200)
  assert.equal((await fetch(new URL('/.git/config', server.url))).status, 404)
})

test('CLI routes real writes to overlays and rejects raw-file and source-local output writes', async (t) => {
  const env = await environment(t)
  const cli = new URL('../../../scripts/blg.mjs', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const command = fileURLToPath(cli)
  await git(env.source, 'switch', '-c', 'feature/cli')
  const loaded = await loadWorkspace(env.source, env.options)
  const envelope = patchFor(loaded, [{ op: 'replace', path: '/nodes/root/summary', value: 'CLI verified route' }])
  const patchPath = path.join(env.temporary, 'patch.json')
  await writeFile(patchPath, JSON.stringify(envelope))
  const result = await exec(process.execPath, [command, 'patch', env.source, patchPath, '--data-root', env.dataRoot, '--write'], { windowsHide: true })
  assert.equal(JSON.parse(result.stdout).scope, 'branch')
  assert.equal((await loadWorkspace(env.source, env.options)).graph.nodes.root.summary, 'CLI verified route')
  await assert.rejects(exec(process.execPath, [command, 'patch', env.created.baselinePath, patchPath, '--write']), (error) => /Direct graph-file writes/.test(error.stderr))
  const forbidden = path.join(env.source, 'map.html')
  await assert.rejects(exec(process.execPath, [command, 'render', env.source, forbidden, '--data-root', env.dataRoot]), (error) => /outside/.test(error.stderr))
  await assert.rejects(stat(forbidden), { code: 'ENOENT' })
})

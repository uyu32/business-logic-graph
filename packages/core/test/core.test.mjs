import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import {
  applyPatchEnvelope,
  buildContext,
  buildIndex,
  candidateToUnverifiedEvidence,
  computeRepositorySnapshot,
  createPreviewServer,
  evaluatePlanGate,
  injectLiveReload,
  markEvidencePathsStale,
  normalizeEvidenceCandidates,
  renderStandaloneViewer,
  validateGraph,
} from '../src/index.mjs'

const fixtureUrl = new URL('../../../examples/order-demo/graph.json', import.meta.url)

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'))
}

test('validates the synthetic order graph and builds deterministic indexes', async () => {
  const graph = await fixture()
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [], warnings: [] })
  const index = buildIndex(graph)
  assert.deepEqual(index.childrenByParent['order-filter'], ['order-minimum-filter'])
  assert.ok(index.lookup.symbols.filterOrders.includes('ev-filter-source'))
})

test('detects parent cycles and broken references', async () => {
  const graph = await fixture()
  graph.nodes['order-process'].parentId = 'order-filter'
  graph.edges['edge-order-1'].to = 'missing-node'
  const result = validateGraph(graph)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.message.includes('parent cycle')))
  assert.ok(result.errors.some((error) => error.path === '/edges/edge-order-1/to'))
})

test('loads only the focused progressive context and its evidence', async () => {
  const graph = await fixture()
  const context = buildContext(graph, '金额过滤', { depth: 0, maxNodes: 8 })
  assert.equal(context.focusId, 'order-minimum-filter')
  assert.ok(context.nodes['order-process'])
  assert.ok(context.nodes['order-filter'])
  assert.ok(context.nodes['order-minimum-filter'])
  assert.equal(context.nodes['inventory-process'], undefined)
  assert.ok(context.evidence['ev-minimum-config'])
})

test('plan gate passes current order-filter claims and blocks stale inventory claims', async () => {
  const graph = await fixture()
  const driver = evaluatePlanGate(graph, ['order-filter'])
  assert.equal(driver.ready, true)
  assert.deepEqual(driver.blockers, [])

  const v2 = evaluatePlanGate(graph, ['inventory-process'])
  assert.equal(v2.ready, false)
  assert.equal(v2.blockers[0].claimId, 'claim-inventory-reservation')
})

test('applies a patch transaction without mutating the input', async () => {
  const graph = await fixture()
  const result = applyPatchEnvelope(graph, {
    schemaVersion: '0.1.0',
    baseGraphRevision: 1,
    repositoryHead: graph.repository.head,
    reason: 'Clarify a business purpose',
    operations: [
      { op: 'test', path: '/nodes/order-filter/title', value: '按金额策略过滤' },
      { op: 'replace', path: '/nodes/order-filter/summary', value: '先按金额配置过滤，再返回排队结果。' },
    ],
    postconditions: { expectedGraphRevision: 2 },
  }, { now: '2026-09-12T00:00:00.000Z' })

  assert.equal(graph.graphRevision, 1)
  assert.equal(result.graph.graphRevision, 2)
  assert.equal(result.graph.updatedAt, '2026-09-12T00:00:00.000Z')
  assert.equal(result.graph.nodes['order-filter'].summary, '先按金额配置过滤，再返回排队结果。')
})

test('rejects stale revisions, head mismatches, and user locks', async () => {
  const graph = await fixture()
  const base = {
    schemaVersion: '0.1.0',
    baseGraphRevision: 1,
    repositoryHead: graph.repository.head,
    reason: 'Attempt an update',
    operations: [{ op: 'replace', path: '/claims/claim-minimum-filter/statement', value: 'changed' }],
  }

  assert.throws(() => applyPatchEnvelope(graph, { ...base, baseGraphRevision: 0 }), /Stale graph revision/)
  assert.throws(() => applyPatchEnvelope(graph, base, { currentHead: 'newer-head' }), /Repository head mismatch/)

  graph.claims['claim-minimum-filter'].locked = true
  assert.throws(() => applyPatchEnvelope(graph, base), /locked by a user correction/)
  assert.throws(() => applyPatchEnvelope(graph, {
    ...base,
    operations: [{ op: 'replace', path: '/claims', value: {} }],
  }), /claims map contains a claim locked/)
})

test('normalizes provider output without promoting it to verified evidence', () => {
  const candidates = normalizeEvidenceCandidates('codegraph', [
    { kind: 'source', locator: { path: 'src\\orders.mjs', symbol: 'filterOrders' }, reason: 'call-chain match', score: 1.4 },
    { kind: 'other', locator: { path: 'ignored' }, reason: 'unsupported' },
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].locator.path, 'src/orders.mjs')
  assert.equal(candidates[0].score, 1)

  const evidence = candidateToUnverifiedEvidence(candidates[0], 'ev-candidate', ['claim-filter-entry'])
  assert.equal(evidence.kind, 'provider-candidate')
  assert.equal(evidence.verification.status, 'candidate')
})

test('creates a deterministic source snapshot and excludes BLG artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blg-snapshot-'))
  try {
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, '.business-logic'))
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const value = 1\n')
    await writeFile(path.join(root, '.business-logic', 'graph.json'), '{"changes":"ignored"}\n')
    const first = await computeRepositorySnapshot(root)
    await writeFile(path.join(root, '.business-logic', 'graph.json'), '{"changes":"still ignored"}\n')
    const second = await computeRepositorySnapshot(root)
    assert.equal(first.fileCount, 1)
    assert.equal(first.revision, second.revision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renders a self-contained HTML viewer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blg-render-'))
  try {
    const dist = path.join(root, 'dist')
    await mkdir(path.join(dist, 'assets'), { recursive: true })
    await writeFile(path.join(dist, 'index.html'), '<html><head><link rel="icon" href="./favicon.svg"><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>')
    await writeFile(path.join(dist, 'assets', 'app.css'), 'body{color:white}')
    await writeFile(path.join(dist, 'assets', 'app.js'), 'document.body.dataset.ready="yes";"$&".replace(/./g,"ok")')
    const outputPath = path.join(root, 'viewer', 'index.html')
    const graph = await fixture()
    const result = await renderStandaloneViewer({ graph, viewerDist: dist, outputPath })
    const html = await readFile(outputPath, 'utf8')
    assert.equal(result.outputPath, outputPath)
    assert.match(html, /window\.__BLG_GRAPH__/)
    assert.match(html, /document\.body\.dataset\.ready/)
    assert.doesNotMatch(html, /src="\/assets/)
    assert.doesNotMatch(html, /href="\/assets/)
    assert.match(html, /"\$&"\.replace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('marks claims and evidence stale when a referenced source changes', async () => {
  const graph = await fixture()
  const result = markEvidencePathsStale(graph, ['src\\orders.mjs'], {
    now: '2026-09-12T01:00:00.000Z',
  })
  assert.equal(result.changed, true)
  assert.equal(graph.repository.dirty, false)
  assert.equal(result.graph.repository.dirty, true)
  assert.equal(result.graph.graphRevision, graph.graphRevision + 1)
  assert.equal(result.graph.updatedAt, '2026-09-12T01:00:00.000Z')
  assert.equal(result.graph.evidence['ev-filter-source'].verification.status, 'stale')
  assert.equal(result.graph.claims['claim-filter-entry'].verification.status, 'stale')
  assert.equal(result.graph.claims['claim-minimum-filter'].verification.status, 'stale')
  assert.equal(graph.evidence['ev-filter-source'].verification.status, 'verified')
})

test('serves the standalone viewer with development-only live reload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blg-preview-'))
  let preview
  try {
    await mkdir(path.join(root, 'viewer'), { recursive: true })
    await writeFile(path.join(root, 'viewer', 'index.html'), '<html><body>BLG</body></html>')
    preview = await createPreviewServer({ root, port: 0 })
    const response = await fetch(preview.url)
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.match(html, /data-blg-live-reload/)
    assert.match(injectLiveReload('<body></body>'), /EventSource/)
    const clientScript = injectLiveReload('<body></body>').match(/<script data-blg-live-reload>([\s\S]*?)<\/script>/)[1]
    assert.doesNotThrow(() => new Script(clientScript), 'live reload client must be valid JavaScript')
    assert.equal(await readFile(path.join(root, 'viewer', 'index.html'), 'utf8'), '<html><body>BLG</body></html>')
  } finally {
    if (preview) await preview.close()
    await rm(root, { recursive: true, force: true })
  }
})

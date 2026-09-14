const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function push(errors, path, message) {
  errors.push({ path, message })
}

function validateMap(errors, value, path) {
  if (!isRecord(value)) {
    push(errors, path, 'must be an object map')
    return false
  }
  return true
}

function validateId(errors, value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    push(errors, path, 'must be a stable lowercase id')
    return false
  }
  return true
}

export function validateGraph(graph) {
  const errors = []
  const warnings = []

  if (!isRecord(graph)) {
    return { valid: false, errors: [{ path: '', message: 'graph must be an object' }], warnings }
  }
  if (graph.schemaVersion !== '0.1.0') push(errors, '/schemaVersion', 'must equal 0.1.0')
  validateId(errors, graph.graphId, '/graphId')
  if (!Number.isInteger(graph.graphRevision) || graph.graphRevision < 0) {
    push(errors, '/graphRevision', 'must be a non-negative integer')
  }
  if (!isRecord(graph.repository)) {
    push(errors, '/repository', 'must be an object')
  } else {
    if (typeof graph.repository.root !== 'string') push(errors, '/repository/root', 'must be a string')
    if (typeof graph.repository.head !== 'string' || graph.repository.head.length === 0) {
      push(errors, '/repository/head', 'must be a non-empty string')
    }
  }

  const maps = ['nodes', 'edges', 'claims', 'evidence']
  for (const name of maps) validateMap(errors, graph[name], `/${name}`)
  if (errors.some((error) => maps.some((name) => error.path === `/${name}`))) {
    return { valid: false, errors, warnings }
  }

  for (const [key, node] of Object.entries(graph.nodes)) {
    const path = `/nodes/${key}`
    validateId(errors, key, path)
    if (!isRecord(node)) {
      push(errors, path, 'must be an object')
      continue
    }
    if (node.id !== key) push(errors, `${path}/id`, 'must match its map key')
    if (typeof node.title !== 'string' || node.title.length === 0) push(errors, `${path}/title`, 'must be non-empty')
    if (typeof node.summary !== 'string') push(errors, `${path}/summary`, 'must be a string')
    if (node.parentId !== null && typeof node.parentId !== 'string') push(errors, `${path}/parentId`, 'must be a node id or null')
    if (node.parentId !== null && !graph.nodes[node.parentId]) push(errors, `${path}/parentId`, `references missing node ${node.parentId}`)
    if (node.parentId === key) push(errors, `${path}/parentId`, 'cannot reference itself')
    for (const claimId of node.claimIds ?? []) {
      if (!graph.claims[claimId]) push(errors, `${path}/claimIds`, `references missing claim ${claimId}`)
    }
  }

  const visitState = new Map()
  function visitNode(id, trail = []) {
    const state = visitState.get(id)
    if (state === 'done') return
    if (state === 'visiting') {
      push(errors, `/nodes/${id}/parentId`, `creates a parent cycle: ${[...trail, id].join(' -> ')}`)
      return
    }
    visitState.set(id, 'visiting')
    const parentId = graph.nodes[id]?.parentId
    if (parentId && graph.nodes[parentId]) visitNode(parentId, [...trail, id])
    visitState.set(id, 'done')
  }
  for (const id of Object.keys(graph.nodes)) visitNode(id)

  for (const [key, edge] of Object.entries(graph.edges)) {
    const path = `/edges/${key}`
    if (!isRecord(edge)) {
      push(errors, path, 'must be an object')
      continue
    }
    if (edge.id !== key) push(errors, `${path}/id`, 'must match its map key')
    if (!graph.nodes[edge.from]) push(errors, `${path}/from`, `references missing node ${edge.from}`)
    if (!graph.nodes[edge.to]) push(errors, `${path}/to`, `references missing node ${edge.to}`)
    for (const claimId of edge.claimIds ?? []) {
      if (!graph.claims[claimId]) push(errors, `${path}/claimIds`, `references missing claim ${claimId}`)
    }
  }

  const claimStatuses = new Set(['verified', 'inferred', 'user-confirmed', 'stale', 'conflict', 'unknown'])
  for (const [key, claim] of Object.entries(graph.claims)) {
    const path = `/claims/${key}`
    if (!isRecord(claim)) {
      push(errors, path, 'must be an object')
      continue
    }
    if (claim.id !== key) push(errors, `${path}/id`, 'must match its map key')
    if (!graph.nodes[claim.nodeId]) push(errors, `${path}/nodeId`, `references missing node ${claim.nodeId}`)
    if (typeof claim.statement !== 'string' || claim.statement.length === 0) push(errors, `${path}/statement`, 'must be non-empty')
    if (!isRecord(claim.verification) || !claimStatuses.has(claim.verification.status)) {
      push(errors, `${path}/verification/status`, 'has an unsupported status')
    }
    if (!Array.isArray(claim.evidenceIds)) push(errors, `${path}/evidenceIds`, 'must be an array')
    for (const evidenceId of claim.evidenceIds ?? []) {
      const item = graph.evidence[evidenceId]
      if (!item) push(errors, `${path}/evidenceIds`, `references missing evidence ${evidenceId}`)
      else if (!(item.claimIds ?? []).includes(key)) warnings.push({ path, message: `evidence ${evidenceId} does not link back to claim ${key}` })
    }
    if (claim.planGate === 'required' && (claim.evidenceIds ?? []).length === 0) {
      warnings.push({ path, message: 'required plan-gate claim has no evidence' })
    }
  }

  const evidenceStatuses = new Set(['candidate', 'verified', 'stale', 'rejected'])
  for (const [key, item] of Object.entries(graph.evidence)) {
    const path = `/evidence/${key}`
    if (!isRecord(item)) {
      push(errors, path, 'must be an object')
      continue
    }
    if (item.id !== key) push(errors, `${path}/id`, 'must match its map key')
    if (!isRecord(item.locator) || typeof item.locator.path !== 'string' || item.locator.path.length === 0) {
      push(errors, `${path}/locator`, 'must contain a non-empty path')
    }
    if (!isRecord(item.verification) || !evidenceStatuses.has(item.verification.status)) {
      push(errors, `${path}/verification/status`, 'has an unsupported status')
    }
    if (!Array.isArray(item.claimIds)) push(errors, `${path}/claimIds`, 'must be an array')
    for (const claimId of item.claimIds ?? []) {
      const claim = graph.claims[claimId]
      if (!claim) push(errors, `${path}/claimIds`, `references missing claim ${claimId}`)
      else if (!(claim.evidenceIds ?? []).includes(key)) warnings.push({ path, message: `claim ${claimId} does not link back to evidence ${key}` })
    }
  }

  for (const [key, tour] of Object.entries(graph.tours ?? {})) {
    if (tour.id !== key) push(errors, `/tours/${key}/id`, 'must match its map key')
    for (const nodeId of tour.nodeIds ?? []) {
      if (!graph.nodes[nodeId]) push(errors, `/tours/${key}/nodeIds`, `references missing node ${nodeId}`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

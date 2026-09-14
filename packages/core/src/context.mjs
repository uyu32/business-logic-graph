function sortedNodes(nodes) {
  return [...nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
}

export function buildIndex(graph) {
  const childrenByParent = {}
  const claimsByNode = {}
  const incomingByNode = {}
  const outgoingByNode = {}
  const lookup = { tags: {}, routes: {}, symbols: {}, text: {} }

  for (const node of Object.values(graph.nodes)) {
    const parentKey = node.parentId ?? '$root'
    ;(childrenByParent[parentKey] ??= []).push(node.id)
    claimsByNode[node.id] = [...(node.claimIds ?? [])]
    for (const tag of node.tags ?? []) (lookup.tags[tag] ??= []).push(node.id)
    const tokens = `${node.title} ${node.summary} ${(node.tags ?? []).join(' ')}`.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    for (const token of new Set(tokens.filter((part) => part.length > 1))) (lookup.text[token] ??= []).push(node.id)
  }
  for (const edge of Object.values(graph.edges)) {
    ;(outgoingByNode[edge.from] ??= []).push(edge.id)
    ;(incomingByNode[edge.to] ??= []).push(edge.id)
  }
  for (const item of Object.values(graph.evidence)) {
    if (item.locator.symbol) (lookup.symbols[item.locator.symbol] ??= []).push(item.id)
    if (item.locator.path) (lookup.routes[item.locator.path] ??= []).push(item.id)
  }
  for (const ids of Object.values(childrenByParent)) ids.sort((a, b) => {
    const left = graph.nodes[a]
    const right = graph.nodes[b]
    return (left.order ?? 0) - (right.order ?? 0) || a.localeCompare(b)
  })
  return {
    graphId: graph.graphId,
    graphRevision: graph.graphRevision,
    repositoryHead: graph.repository.head,
    childrenByParent,
    claimsByNode,
    incomingByNode,
    outgoingByNode,
    lookup,
  }
}

export function resolveFocus(graph, query) {
  if (graph.nodes[query]) return query
  const normalized = query.trim().toLowerCase()
  const words = normalized.split(/\s+/).filter(Boolean)
  const ideographs = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized)
    ? [...normalized].filter((character) => /[\p{L}\p{N}]/u.test(character))
    : []
  const ranked = Object.values(graph.nodes)
    .map((node) => {
      const haystack = `${node.title} ${node.summary} ${(node.tags ?? []).join(' ')}`.toLowerCase()
      let score = haystack.includes(normalized) ? 10 : 0
      for (const token of words) if (haystack.includes(token)) score += 2
      for (const character of ideographs) if (haystack.includes(character)) score += 1
      return { id: node.id, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return ranked[0]?.id ?? null
}

function aggregateStatus(graph, nodeId) {
  const claims = Object.values(graph.claims).filter((claim) => claim.nodeId === nodeId)
  const statuses = new Set(claims.map((claim) => claim.verification.status))
  if (statuses.has('conflict')) return 'conflict'
  if (statuses.has('stale')) return 'stale'
  if (statuses.has('unknown')) return 'unknown'
  if (statuses.has('inferred')) return 'inferred'
  if (statuses.size > 0 && [...statuses].every((status) => status === 'verified' || status === 'user-confirmed')) return 'verified'
  return 'unknown'
}

export function buildContext(graph, focusQuery, options = {}) {
  const focusId = resolveFocus(graph, focusQuery)
  if (!focusId) throw new Error(`No business node matches: ${focusQuery}`)
  const depth = Number.isInteger(options.depth) ? options.depth : 1
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : 32
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 24000
  if (maxNodes < 1 || depth < 0 || maxChars < 256) throw new Error('Context requires maxNodes >= 1, depth >= 0, maxChars >= 256')
  const index = buildIndex(graph)
  const selected = new Set()
  const queue = [{ id: focusId, depth: 0 }]

  let cursor = graph.nodes[focusId]
  while (cursor) {
    selected.add(cursor.id)
    cursor = cursor.parentId ? graph.nodes[cursor.parentId] : null
  }
  const essential = new Set(selected)
  if (selected.size > maxNodes) throw new Error('Ancestor path exceeds maxNodes; explicitly increase the node budget')

  while (queue.length > 0 && selected.size < maxNodes) {
    const current = queue.shift()
    selected.add(current.id)
    if (current.depth >= depth) continue
    for (const childId of index.childrenByParent[current.id] ?? []) {
      if (selected.size >= maxNodes) break
      queue.push({ id: childId, depth: current.depth + 1 })
    }
  }

  for (const edgeId of [...(index.incomingByNode[focusId] ?? []), ...(index.outgoingByNode[focusId] ?? [])]) {
    if (selected.size >= maxNodes) break
    const edge = graph.edges[edgeId]
    selected.add(edge.from)
    if (selected.size < maxNodes) selected.add(edge.to)
  }

  function packet() {
  const nodeIds = [...selected]
  const nodes = Object.fromEntries(sortedNodes(nodeIds.map((id) => graph.nodes[id])).map((node) => [node.id, { ...node, aggregateStatus: aggregateStatus(graph, node.id) }]))
  const edges = Object.fromEntries(Object.values(graph.edges)
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .map((edge) => [edge.id, edge]))
  const claims = Object.fromEntries(Object.values(graph.claims)
    .filter((claim) => selected.has(claim.nodeId))
    .map((claim) => [claim.id, claim]))
  const evidenceIds = new Set(Object.values(claims).flatMap((claim) => claim.evidenceIds ?? []))
  const evidence = Object.fromEntries([...evidenceIds].filter((id) => graph.evidence[id]).map((id) => [id, graph.evidence[id]]))

  const descendantsAvailable = (index.childrenByParent[focusId] ?? []).some((id) => !selected.has(id)) ||
    [...selected].some((id) => (index.childrenByParent[id] ?? []).some((child) => !selected.has(child)))

  const result = {
    schemaVersion: graph.schemaVersion,
    graphId: graph.graphId,
    graphRevision: graph.graphRevision,
    repository: graph.repository,
    scope: graph.view ? { repoId: graph.view.repoId, scope: graph.view.scope, baselineRef: graph.view.baselineRef, sourceBranch: graph.view.sourceBranch, worktreeId: graph.view.worktreeId, overlayId: graph.view.overlayId, overlayRevision: graph.view.overlayRevision, baselineAdvanced: graph.view.baselineAdvanced, conflictCount: graph.view.conflicts.length, conflicts: graph.view.conflicts.slice(0, 12).map(({ path, message }) => ({ path, message })) } : undefined,
    focusId,
    depth,
    truncated: selected.size >= maxNodes || descendantsAvailable,
    nodes,
    edges,
    claims,
    evidence,
    expansionHints: [...selected]
      .filter((id) => (index.childrenByParent[id] ?? []).some((child) => !selected.has(child)))
      .map((id) => ({ nodeId: id, remainingChildren: (index.childrenByParent[id] ?? []).filter((child) => !selected.has(child)).length })),
  }
  return result
  }
  let result = packet()
  while (JSON.stringify(result, null, 2).length + 1 > maxChars) {
    const removable = [...selected].reverse().find((id) => !essential.has(id))
    if (!removable) throw new Error(`Focused node and required evidence exceed ${maxChars} characters. Narrow the focus or explicitly increase --max-chars; evidence will not be silently dropped.`)
    selected.delete(removable)
    result = packet()
    result.truncated = true
  }
  return result
}

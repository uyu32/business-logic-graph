import type { BlgClaim, BlgGraph, BlgNode, ClaimStatus, GateSummary } from './types'

const STATUS_PRIORITY: ClaimStatus[] = ['conflict', 'stale', 'unknown', 'inferred', 'verified']

export function parseGraph(raw: string): BlgGraph {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object') throw new Error('BLG 文件必须是 JSON 对象')
  const graph = value as Partial<BlgGraph>
  if (graph.schemaVersion !== '0.1.0') throw new Error('当前 Viewer 只支持 BLG schemaVersion 0.1.0')
  if (!graph.nodes || !graph.edges || !graph.claims || !graph.evidence || !graph.repository) {
    throw new Error('缺少 nodes、edges、claims、evidence 或 repository')
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (id !== node.id) throw new Error(`节点 map key 与 id 不一致：${id}`)
    if (node.parentId && !graph.nodes[node.parentId]) throw new Error(`节点 ${id} 的父节点不存在：${node.parentId}`)
  }
  return graph as BlgGraph
}

export function childrenOf(graph: BlgGraph, parentId: string | null): BlgNode[] {
  return Object.values(graph.nodes)
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
}

export function claimsForNode(graph: BlgGraph, nodeId: string): BlgClaim[] {
  return Object.values(graph.claims).filter((claim) => claim.nodeId === nodeId)
}

export function nodeStatus(graph: BlgGraph, nodeId: string): ClaimStatus {
  const statuses = new Set(claimsForNode(graph, nodeId).map((claim) => claim.verification.status))
  if (statuses.size === 0) return 'unknown'
  if ([...statuses].every((status) => status === 'verified' || status === 'user-confirmed')) return 'verified'
  return STATUS_PRIORITY.find((status) => statuses.has(status)) ?? 'unknown'
}

export function collectDescendants(graph: BlgGraph, rootId: string): Set<string> {
  const result = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of Object.values(graph.nodes)) {
      if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
        result.add(node.id)
        changed = true
      }
    }
  }
  return result
}

export function gateForNode(graph: BlgGraph, nodeId: string): GateSummary {
  const scope = collectDescendants(graph, nodeId)
  const required = Object.values(graph.claims).filter((claim) => scope.has(claim.nodeId) && claim.planGate === 'required')
  const blockers = required.filter((claim) => {
    const statusCurrent = claim.verification.status === 'verified' || claim.verification.status === 'user-confirmed'
    const unchanged = claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => graph.evidence[id]?.kind === 'user' || graph.view?.evidenceChecks?.[id] === true)
    const commitCurrent = claim.verification.status === 'user-confirmed' || claim.verification.commit === graph.repository.head || unchanged
    const hasEvidence = claim.evidenceIds.some((id) => {
      const evidence = graph.evidence[id]
      return evidence?.verification.status === 'verified' &&
        (evidence.kind === 'user' || evidence.verification.commit === graph.repository.head || graph.view?.evidenceChecks?.[id] === true)
    })
    return !statusCurrent || !commitCurrent || !hasEvidence
  })
  return { ready: blockers.length === 0 && !graph.view?.baselineAdvanced && !graph.view?.conflicts.length && graph.view?.nodeChanges[nodeId]?.kind !== 'deleted', requiredClaims: required.length, blockers }
}

export function visibleNodeIds(graph: BlgGraph, expanded: Set<string>): Set<string> {
  const visible = new Set<string>()
  const visit = (parentId: string | null) => {
    for (const node of childrenOf(graph, parentId)) {
      visible.add(node.id)
      if (expanded.has(node.id)) visit(node.id)
    }
  }
  visit(null)
  return visible
}

export function ancestorIds(graph: BlgGraph, nodeId: string): string[] {
  const result: string[] = []
  let current = graph.nodes[nodeId]
  while (current?.parentId) {
    result.unshift(current.parentId)
    current = graph.nodes[current.parentId]
  }
  return result
}

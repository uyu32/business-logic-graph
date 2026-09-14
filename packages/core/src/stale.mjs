function normalizeLocatorPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

export function markEvidencePathsStale(graph, changedPaths, { now = new Date().toISOString() } = {}) {
  const paths = new Set(changedPaths.map(normalizeLocatorPath))
  const next = structuredClone(graph)
  const evidenceIds = []
  const claimIds = new Set()

  for (const evidence of Object.values(next.evidence)) {
    if (!paths.has(normalizeLocatorPath(evidence.locator.path))) continue
    if (evidence.verification.status === 'verified') {
      evidence.verification.status = 'stale'
      evidenceIds.push(evidence.id)
    }
    for (const claimId of evidence.claimIds) claimIds.add(claimId)
  }

  const staleClaimIds = []
  for (const claimId of claimIds) {
    const claim = next.claims[claimId]
    if (!claim || claim.verification.status === 'user-confirmed') continue
    if (claim.verification.status !== 'stale') {
      claim.verification.status = 'stale'
      claim.verification.note = `Evidence source changed during preview: ${[...paths].join(', ')}`
      staleClaimIds.push(claimId)
    }
  }

  const changed = evidenceIds.length > 0 || staleClaimIds.length > 0 || (claimIds.size > 0 && next.repository.dirty !== true)
  if (!changed) return { graph, changed: false, evidenceIds: [], claimIds: [] }

  next.repository.dirty = true
  next.graphRevision += 1
  next.updatedAt = now
  return {
    graph: next,
    changed: true,
    evidenceIds,
    claimIds: staleClaimIds,
  }
}

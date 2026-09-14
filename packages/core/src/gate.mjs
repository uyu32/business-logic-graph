function descendants(graph, roots) {
  const selected = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const node of Object.values(graph.nodes)) {
      if (node.parentId && selected.has(node.parentId) && !selected.has(node.id)) {
        selected.add(node.id)
        changed = true
      }
    }
  }
  return selected
}

export function evaluatePlanGate(graph, affectedNodeIds) {
  const missingNodes = affectedNodeIds.filter((id) => !graph.nodes[id])
  const scope = descendants(graph, affectedNodeIds.filter((id) => graph.nodes[id]))
  const blockers = missingNodes.map((id) => ({ code: 'missing-node', nodeId: id, message: `Affected node ${id} does not exist` }))
  if (graph.view?.baselineAdvanced) blockers.push({ code: 'baseline-advanced', message: 'Master graph advanced; explicitly rebase and reverify the affected branch subgraph' })
  for (const conflict of graph.view?.conflicts ?? []) blockers.push({ code: 'overlay-conflict', message: conflict.message, path: conflict.path })
  const warnings = []
  const checkedClaimIds = []

  for (const claim of Object.values(graph.claims)) {
    if (!scope.has(claim.nodeId) || claim.planGate === 'none') continue
    checkedClaimIds.push(claim.id)
    const required = claim.planGate === 'required'
    const status = claim.verification.status
    const current = status === 'verified' || status === 'user-confirmed'
    const unchanged = claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => graph.evidence[id]?.kind === 'user' || graph.view?.evidenceChecks?.[id] === true)
    const commitCurrent = status === 'user-confirmed' || claim.verification.commit === graph.repository.head || unchanged
    const verifiedEvidence = (claim.evidenceIds ?? [])
      .map((id) => graph.evidence[id])
      .filter(Boolean)
      .some((item) => item.verification.status === 'verified' && (item.kind === 'user' || item.verification.commit === graph.repository.head || graph.view?.evidenceChecks?.[item.id] === true))

    const issue = !current
      ? `claim status is ${status}`
      : !commitCurrent
        ? `claim was verified at ${claim.verification.commit ?? 'no commit'}, not ${graph.repository.head}`
        : !verifiedEvidence
          ? 'claim has no current verified evidence'
          : null

    if (issue) {
      const item = { code: 'unready-claim', nodeId: claim.nodeId, claimId: claim.id, message: issue }
      if (required) blockers.push(item)
      else warnings.push(item)
    }
  }

  return {
    ready: blockers.length === 0,
    repositoryHead: graph.repository.head,
    affectedNodeIds: [...scope],
    checkedClaimIds,
    blockers,
    warnings,
  }
}

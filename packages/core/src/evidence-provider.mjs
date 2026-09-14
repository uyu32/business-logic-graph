const ALLOWED_KINDS = new Set(['source', 'config', 'test', 'runtime'])

export function normalizeEvidenceCandidates(providerId, candidates, limit = 50) {
  if (typeof providerId !== 'string' || providerId.length === 0) throw new Error('providerId is required')
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array')
  return candidates
    .filter((candidate) => candidate && ALLOWED_KINDS.has(candidate.kind) && typeof candidate.locator?.path === 'string')
    .map((candidate) => ({
      provider: providerId,
      kind: candidate.kind,
      locator: {
        path: candidate.locator.path.replaceAll('\\', '/'),
        ...(candidate.locator.symbol ? { symbol: candidate.locator.symbol } : {}),
        ...(candidate.locator.stableKey ? { stableKey: candidate.locator.stableKey } : {}),
        ...(candidate.locator.lineStart ? { lineStart: candidate.locator.lineStart } : {}),
        ...(candidate.locator.lineEnd ? { lineEnd: candidate.locator.lineEnd } : {}),
      },
      reason: String(candidate.reason ?? ''),
      score: Number.isFinite(candidate.score) ? Math.max(0, Math.min(1, candidate.score)) : 0,
      providerMetadata: candidate.providerMetadata ?? {},
    }))
    .sort((left, right) => right.score - left.score || left.locator.path.localeCompare(right.locator.path))
    .slice(0, limit)
}

export function candidateToUnverifiedEvidence(candidate, id, claimIds = []) {
  return {
    id,
    kind: 'provider-candidate',
    provider: candidate.provider,
    locator: candidate.locator,
    summary: candidate.reason,
    claimIds,
    verification: { status: 'candidate' },
  }
}

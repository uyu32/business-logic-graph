# Evidence Provider contract

Evidence Providers reduce the repository search space. They never decide that a
business claim is true and they never write the graph directly.

```ts
interface EvidenceProvider {
  id: string
  health(): Promise<{ available: boolean; detail?: string }>
  search(request: EvidenceSearchRequest): Promise<EvidenceCandidate[]>
  expand?(candidate: EvidenceCandidate): Promise<EvidenceCandidate[]>
}

interface EvidenceSearchRequest {
  repositoryRoot: string
  repositoryHead: string
  businessQuery: string
  focusNodeIds: string[]
  kinds: Array<'source' | 'config' | 'test' | 'runtime'>
  limit: number
}

interface EvidenceCandidate {
  provider: string
  kind: 'source' | 'config' | 'test' | 'runtime'
  locator: {
    path: string
    symbol?: string
    stableKey?: string
    lineStart?: number
    lineEnd?: number
  }
  reason: string
  score?: number
  providerMetadata?: Record<string, unknown>
}
```

The BLG verifier must open the candidate's source, configuration, or test at the
current Git head. Only then may it create normal evidence with
`verification.status = "verified"` and a fingerprint. Unopened CodeGraph output
is stored, when useful, as `kind = "provider-candidate"` and remains a candidate.

The initial provider order is:

1. CodeGraph, when available, for symbol/call/dependency/test candidates.
2. `rg` plus language tooling as the deterministic fallback.
3. Direct repository reads for final verification in both cases.

Provider-specific IDs and database keys must not become BLG node or claim IDs.
Stable BLG locators use repository-relative paths, language symbols, semantic
stable keys, and content fingerprints.

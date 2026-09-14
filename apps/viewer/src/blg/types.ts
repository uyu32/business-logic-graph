export type ClaimStatus = 'verified' | 'inferred' | 'user-confirmed' | 'stale' | 'conflict' | 'unknown'
export type EvidenceStatus = 'candidate' | 'verified' | 'stale' | 'rejected'

export interface BlgNode {
  id: string
  type: 'business-capability' | 'business-flow' | 'business-step' | 'business-rule' | 'integration' | 'data-change' | 'business-outcome'
  parentId: string | null
  title: string
  summary: string
  businessPurpose?: string
  order?: number
  tags?: string[]
  inputs?: string[]
  outputs?: string[]
  sideEffects?: string[]
  claimIds?: string[]
  locks?: string[]
}

export interface BlgEdge {
  id: string
  from: string
  to: string
  kind: 'next' | 'condition' | 'error' | 'async' | 'data' | 'dependency'
  condition?: string
  label?: string
  order?: number
  claimIds?: string[]
}

export interface BlgClaim {
  id: string
  nodeId: string
  kind: 'code-fact' | 'model-inference' | 'business-confirmation' | 'open-question'
  statement: string
  planGate?: 'required' | 'advisory' | 'none'
  verification: {
    status: ClaimStatus
    commit?: string
    confidence: number
    lastVerifiedAt?: string
    verifiedBy?: string
    note?: string
  }
  evidenceIds: string[]
  locked?: boolean
}

export interface BlgEvidence {
  id: string
  kind: 'source' | 'config' | 'test' | 'runtime' | 'user' | 'provider-candidate'
  provider: string
  locator: {
    path: string
    symbol?: string
    stableKey?: string
    lineStart?: number
    lineEnd?: number
  }
  summary?: string
  claimIds: string[]
  verification: {
    status: EvidenceStatus
    commit?: string
    lastVerifiedAt?: string
    verifiedBy?: string
  }
}

export interface NodeChange {
  kind: 'added' | 'modified' | 'deleted'
  before?: BlgNode
  after?: BlgNode
  beforeClaims?: string[]
  afterClaims?: string[]
}

export interface WorkspaceView {
  repoId: string
  scope: 'baseline' | 'branch'
  baselineRef: string
  baselineSourceHead: string
  recordedBaselineHead: string
  baselineGraphRevision: number
  sourceKind: 'git' | 'snapshot'
  sourceBranch: string | null
  worktreeId: string
  overlayId: string | null
  overlayRevision: number
  baselineAdvanced: boolean
  conflicts: { path: string; message: string }[]
  evidenceChecks: Record<string, boolean>
  nodeChanges: Record<string, NodeChange>
}

export interface BlgGraph {
  schemaVersion: '0.1.0'
  graphId: string
  graphRevision: number
  title?: string
  updatedAt?: string
  repository: {
    root: string
    head: string
    remote?: string
    dirty?: boolean
  }
  nodes: Record<string, BlgNode>
  edges: Record<string, BlgEdge>
  claims: Record<string, BlgClaim>
  evidence: Record<string, BlgEvidence>
  view?: WorkspaceView
}

export interface GateSummary {
  ready: boolean
  requiredClaims: number
  blockers: BlgClaim[]
}

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileJson2,
  GitCommitHorizontal,
  LockKeyhole,
  Search,
  ShieldAlert,
} from 'lucide-react'
import bundledGraphRaw from '../../../examples/order-demo/graph.json?raw'
import { BusinessGraph } from './blg/BusinessGraph'
import {
  ancestorIds,
  childrenOf,
  claimsForNode,
  gateForNode,
  nodeStatus,
  parseGraph,
  visibleNodeIds,
} from './blg/model'
import type { BlgEvidence, BlgGraph, ClaimStatus } from './blg/types'

const STATUS_LABEL: Record<ClaimStatus, string> = {
  verified: '已核实',
  inferred: '模型推断',
  'user-confirmed': '业务确认',
  stale: '等待复核',
  conflict: '存在冲突',
  unknown: '证据不足',
}

declare global {
  interface Window {
    __BLG_GRAPH__?: unknown
  }
}

function firstRoot(graph: BlgGraph) {
  return childrenOf(graph, null)[0]?.id ?? Object.keys(graph.nodes)[0]
}

function storageKey(graph: BlgGraph) {
  return `blg-view:${graph.view?.repoId ?? graph.graphId}:${graph.view?.worktreeId ?? 'file'}:${graph.view?.sourceBranch ?? 'snapshot'}:${graph.view?.scope ?? 'file'}`
}

function restoredView(graph: BlgGraph): { selectedId?: string; expanded?: string[] } {
  try { return JSON.parse(sessionStorage.getItem(storageKey(graph)) ?? '{}') } catch { return {} }
}

export default function App() {
  const hasInjectedGraph = Boolean(window.__BLG_GRAPH__)
  const initial = useMemo(
    () => parseGraph(window.__BLG_GRAPH__ ? JSON.stringify(window.__BLG_GRAPH__) : bundledGraphRaw),
    [],
  )
  const [graph, setGraph] = useState(initial)
  const [selectedId, setSelectedId] = useState(() => restoredView(initial).selectedId ?? firstRoot(graph))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(restoredView(initial).expanded ?? (hasInjectedGraph ? [] : [firstRoot(graph)])))
  const [query, setQuery] = useState('')
  const [sourceLabel, setSourceLabel] = useState(hasInjectedGraph ? '独立 BLG 数据工作区' : '内置合成订单示例')
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem(storageKey(graph), JSON.stringify({ selectedId, expanded: [...expanded] })) } catch { /* file:// or private browsing may deny storage */ }
  }, [graph, selectedId, expanded])
  const displayGraph = useMemo(() => {
    const deleted = Object.fromEntries(Object.entries(graph.view?.nodeChanges ?? {}).filter(([, change]) => change.kind === 'deleted' && change.before).map(([id, change]) => [id, change.before!]))
    return { ...graph, nodes: { ...deleted, ...graph.nodes } }
  }, [graph])
  const visibleIds = useMemo(() => visibleNodeIds(displayGraph, expanded), [expanded, displayGraph])
  const selectedNode = displayGraph.nodes[selectedId] ?? displayGraph.nodes[firstRoot(displayGraph)]
  const selectedChange = graph.view?.nodeChanges[selectedNode?.id]
  const selectedClaims = useMemo(
    () => selectedNode ? claimsForNode(graph, selectedNode.id) : [],
    [graph, selectedNode],
  )
  const selectedStatus = selectedNode ? nodeStatus(graph, selectedNode.id) : 'unknown'
  const gate = selectedNode ? gateForNode(graph, selectedNode.id) : { ready: false, requiredClaims: 0, blockers: [] }
  const breadcrumbs = selectedNode
    ? [...ancestorIds(displayGraph, selectedNode.id), selectedNode.id].map((id) => displayGraph.nodes[id])
    : []
  const evidence = useMemo(() => {
    const ids = new Set(selectedClaims.flatMap((claim) => claim.evidenceIds))
    return [...ids].map((id) => graph.evidence[id]).filter((item): item is BlgEvidence => Boolean(item))
  }, [graph.evidence, selectedClaims])

  const toggleNode = (id: string) => {
    if (childrenOf(displayGraph, id).length === 0) return
    if (expanded.has(id) && ancestorIds(displayGraph, selectedId).includes(id)) setSelectedId(id)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const revealNode = (id: string) => {
    setSelectedId(id)
    setExpanded((current) => new Set([...current, ...ancestorIds(displayGraph, id)]))
  }

  const runSearch = () => {
    const needle = query.trim().toLowerCase()
    if (!needle) return
    const match = Object.values(graph.nodes).find((node) =>
      `${node.id} ${node.title} ${node.summary} ${(node.tags ?? []).join(' ')}`.toLowerCase().includes(needle),
    )
    if (!match) {
      setError(`没有找到与“${query.trim()}”匹配的业务积木`)
      return
    }
    setError(null)
    revealNode(match.id)
  }

  const loadFile = async (file: File) => {
    try {
      const next = parseGraph(await file.text())
      const rootId = firstRoot(next)
      setGraph(next)
      setSelectedId(rootId)
      setExpanded(new Set())
      setSourceLabel(file.name)
      setQuery('')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取这个 BLG 文件')
    }
  }

  if (!selectedNode) return <div className="empty-screen">图中还没有业务节点。</div>

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><Braces size={20} /></div>
        <div className="brand-copy">
          <strong>{graph.title ?? graph.graphId}</strong>
          <span>{sourceLabel}</span>
        </div>
        <form
          className="search-box"
          onSubmit={(event) => {
            event.preventDefault()
            runSearch()
          }}
        >
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索业务、规则、路由……"
            aria-label="搜索业务图"
          />
          <kbd>Enter</kbd>
        </form>
        <div className="repo-meta">
          <GitCommitHorizontal size={16} />
          <span title={graph.repository.head}>{graph.repository.head.slice(0, 14)}</span>
          <b>r{graph.graphRevision}</b>
        </div>
        <button className="open-button" type="button" onClick={() => fileRef.current?.click()}>
          <FileJson2 size={17} />打开 BLG
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.target.value = ''
          }}
        />
      </header>

      {graph.view && <div className="context-strip">
        <span>{graph.view.sourceKind === 'snapshot' ? '源码快照（尚无 Git 分支）' : `${graph.view.baselineRef} 基线${graph.view.scope === 'branch' ? ` ＋ ${graph.view.sourceBranch ?? 'detached HEAD'} 增量` : ''}`}</span>
        <span>独立数据仓库 · {graph.view.repoId} · worktree {graph.view.worktreeId.slice(0, 8)}</span>
        {graph.view.baselineAdvanced && <b>基线已更新，需要 rebase</b>}
        {graph.view.conflicts.length > 0 && <b>{graph.view.conflicts.length} 处增量冲突</b>}
      </div>}

      {error && (
        <div className="error-strip" role="alert">
          <CircleAlert size={16} />{error}
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      <section className="workspace">
        <BusinessGraph
          graph={displayGraph}
          visibleIds={visibleIds}
          expanded={expanded}
          selectedId={selectedNode.id}
          onSelect={setSelectedId}
          onToggle={toggleNode}
        />

        <aside className="details-panel">
          <nav className="breadcrumbs" aria-label="业务层级">
            {breadcrumbs.map((node, index) => (
              <span key={node.id}>
                {index > 0 && <ChevronRight size={13} />}
                <button type="button" onClick={() => revealNode(node.id)}>{node.title}</button>
              </span>
            ))}
          </nav>

          <div className="detail-title-row">
            <div>
              <span className="type-label">{selectedNode.type}</span>
              <h1>{selectedNode.title}</h1>
            </div>
            <span className={`status-pill status-${selectedStatus}`}><i />{STATUS_LABEL[selectedStatus]}</span>
          </div>
          <p className="detail-summary">{selectedNode.summary}</p>
          {selectedChange && <section className={`change-detail change-${selectedChange.kind}`}>
            <h2>{selectedChange.kind === 'added' ? '本分支新增逻辑' : selectedChange.kind === 'deleted' ? '本分支删除逻辑（保留基线供对比）' : '本分支修改逻辑'}</h2>
            {selectedChange.before && <div><b>{graph.view?.baselineRef} 原逻辑</b><p>{selectedChange.before.summary}</p>{selectedChange.beforeClaims?.map((statement) => <p key={statement}>{statement}</p>)}</div>}
            {selectedChange.after && <div><b>分支逻辑</b><p>{selectedChange.after.summary}</p>{selectedChange.afterClaims?.map((statement) => <p key={statement}>{statement}</p>)}</div>}
          </section>}

          {childrenOf(displayGraph, selectedNode.id).length > 0 && (
            <button className="expand-action" type="button" onClick={() => toggleNode(selectedNode.id)}>
              {expanded.has(selectedNode.id) ? '收起子逻辑' : `展开 ${childrenOf(displayGraph, selectedNode.id).length} 个子逻辑`}
            </button>
          )}

          <section className={`gate-card ${gate.ready ? 'gate-ready' : 'gate-blocked'}`}>
            {gate.ready ? <CheckCircle2 size={19} /> : <ShieldAlert size={19} />}
            <div>
              <strong>{gate.ready ? '相关逻辑可以进入规划' : '开发计划被核实门禁阻止'}</strong>
              <span>
                {gate.ready
                  ? `${gate.requiredClaims} 条强制断言拥有当前证据`
                  : graph.view?.baselineAdvanced || graph.view?.conflicts.length ? '先解决基线更新或增量冲突，再核实相关逻辑' : selectedChange?.kind === 'deleted' ? '该逻辑已在分支中删除' : `${gate.blockers.length} 条强制断言需要重新核实`}
              </span>
            </div>
          </section>

          {selectedNode.businessPurpose && (
            <InfoBlock title="业务目的" values={[selectedNode.businessPurpose]} />
          )}
          <div className="io-grid">
            <InfoBlock title="输入" values={selectedNode.inputs ?? []} empty="尚未记录" />
            <InfoBlock title="输出" values={selectedNode.outputs ?? []} empty="尚未记录" />
          </div>

          <section className="detail-section">
            <div className="section-heading">
              <h2>业务断言</h2><span>{selectedClaims.length}</span>
            </div>
            {selectedClaims.length === 0 ? (
              <p className="empty-copy">当前粒度还没有断言；需要时再下钻核实。</p>
            ) : selectedClaims.map((claim) => (
              <article className="claim-card" key={claim.id}>
                <div className="claim-meta">
                  <span className={`status-pill status-${claim.verification.status}`}><i />{STATUS_LABEL[claim.verification.status]}</span>
                  <span>{claim.kind}</span>
                  {claim.planGate === 'required' && <b>门禁</b>}
                  {claim.locked && <LockKeyhole size={13} aria-label="用户已锁定" />}
                </div>
                <p>{claim.statement}</p>
                <small>置信度 {Math.round(claim.verification.confidence * 100)}% · {claim.evidenceIds.length} 条证据</small>
              </article>
            ))}
          </section>

          <section className="detail-section evidence-section">
            <div className="section-heading">
              <h2>代码与配置证据</h2><span>{evidence.length}</span>
            </div>
            {evidence.length === 0 ? <p className="empty-copy">选择带断言的节点后查看证据。</p> : evidence.map((item) => (
              <article className={`evidence-card evidence-${item.verification.status}`} key={item.id}>
                <div>
                  <span>{item.kind}</span>
                  <b>{item.provider}</b>
                  <em>{item.verification.status === 'candidate' ? '仅为候选' : item.verification.status === 'verified' ? '已读源码核实' : item.verification.status === 'stale' ? '证据已过期' : '证据已拒绝'}</em>
                </div>
                <code>{item.locator.path}{item.locator.symbol ? `#${item.locator.symbol}` : ''}</code>
                {item.summary && <p>{item.summary}</p>}
              </article>
            ))}
          </section>
        </aside>
      </section>
    </main>
  )
}

function InfoBlock({ title, values, empty }: { title: string; values: string[]; empty?: string }) {
  return (
    <section className="info-block">
      <h2>{title}</h2>
      {values.length > 0 ? (
        <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
      ) : <p>{empty}</p>}
    </section>
  )
}

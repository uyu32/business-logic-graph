import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodes,
  useReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { ChevronDown, ChevronRight, GitBranch, Layers3, ShieldCheck } from 'lucide-react'
import { childrenOf, nodeStatus } from './model'
import type { BlgGraph, BlgNode, ClaimStatus, NodeChange } from './types'

type BusinessNodeData = {
  businessNode: BlgNode
  status: ClaimStatus
  childCount: number
  expanded: boolean
  onToggle: (id: string) => void
  changeKind?: NodeChange['kind']
}

type BusinessFlowNode = Node<BusinessNodeData, 'business-node'>

const elk = new ELK()
const nodeTypes = { 'business-node': BusinessNodeView }
const STATUS_LABEL: Record<ClaimStatus, string> = {
  verified: '已核实',
  inferred: '推断',
  'user-confirmed': '业务确认',
  stale: '待复核',
  conflict: '有冲突',
  unknown: '待补充',
}

function BusinessNodeView({ data, selected }: NodeProps<BusinessFlowNode>) {
  const { businessNode: node, childCount, expanded, status, onToggle, changeKind } = data
  return (
    <article className={`blg-node status-${status} change-${changeKind ?? 'baseline'} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="blg-node__eyebrow">
        <span>{node.type.replace('business-', '')}</span>
        <span className="blg-status"><i />{STATUS_LABEL[status]}</span>
      </div>
      <h3>{node.title}</h3>
      {changeKind && <span className={`change-pill change-${changeKind}`}>{changeKind === 'added' ? '分支新增' : changeKind === 'modified' ? '分支修改' : '分支删除'}</span>}
      <p>{node.summary}</p>
      <div className="blg-node__footer">
        <span>{node.claimIds?.length ?? 0} 条断言</span>
        {childCount > 0 && (
          <button
            type="button"
            className="nodrag"
            onClick={(event) => {
              event.stopPropagation()
              if (event.detail > 1) return
              onToggle(node.id)
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={`${expanded ? '收起' : '展开'} ${node.title}`}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {childCount} 个子块
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}

async function layoutGraph(nodes: BusinessFlowNode[], edges: Edge[]): Promise<BusinessFlowNode[]> {
  if (nodes.length === 0) return nodes
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '44',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: nodes.map((node) => ({ id: node.id, width: 300, height: 190 })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  })
  const positions = new Map((result.children ?? []).map((item) => [item.id, { x: item.x ?? 0, y: item.y ?? 0 }]))
  return nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }))
}

function FitAfterLayout() {
  const initialized = useNodesInitialized()
  const nodes = useNodes()
  const layoutKey = nodes.map((node) => `${node.id}:${node.position.x}:${node.position.y}:${node.measured?.width}:${node.measured?.height}`).join('|')
  const { fitView, viewportInitialized } = useReactFlow()
  useEffect(() => {
    if (initialized && viewportInitialized) void fitView({ padding: 0.18, minZoom: 0.15, maxZoom: 1.05, duration: 180 })
  }, [initialized, viewportInitialized, fitView, layoutKey])
  return null
}

export function BusinessGraph({
  graph,
  visibleIds,
  expanded,
  selectedId,
  onSelect,
  onToggle,
}: {
  graph: BlgGraph
  visibleIds: Set<string>
  expanded: Set<string>
  selectedId: string
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}) {
  const raw = useMemo(() => {
    const nodes: BusinessFlowNode[] = [...visibleIds].map((id) => ({
      id,
      type: 'business-node',
      selected: id === selectedId,
      position: { x: 0, y: 0 },
      data: {
        businessNode: graph.nodes[id],
        status: nodeStatus(graph, id),
        childCount: childrenOf(graph, id).length,
        expanded: expanded.has(id),
        onToggle,
        changeKind: graph.view?.nodeChanges[id]?.kind,
      },
    }))
    const edges: Edge[] = Object.values(graph.edges)
      .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
      .map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.condition ?? edge.label,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        className: `flow-edge edge-${edge.kind}`,
      }))
    for (const node of nodes) {
      const parentId = node.data.businessNode.parentId
      if (!parentId || !visibleIds.has(parentId) || edges.some((edge) => edge.source === parentId && edge.target === node.id)) continue
      edges.push({
        id: `contains:${parentId}:${node.id}`,
        source: parentId,
        target: node.id,
        type: 'smoothstep',
        className: 'contains-edge',
        label: '包含',
      })
    }
    return { nodes, edges }
  }, [expanded, graph, onToggle, selectedId, visibleIds])

  const [nodes, setNodes] = useState(raw.nodes)
  useEffect(() => {
    let cancelled = false
    layoutGraph(raw.nodes, raw.edges).then((laidOut) => {
      if (!cancelled) setNodes((previous) => {
        const measured = new Map(previous.map((node) => [node.id, node.measured]))
        return laidOut.map((node) => ({ ...node, measured: measured.get(node.id) }))
      })
    })
    return () => { cancelled = true }
  }, [raw])

  return (
    <div className="graph-surface">
      <div className="graph-legend" aria-label="图例">
        <span><Layers3 size={14} />单击看证据 · 双击展开/折叠</span>
        <span><GitBranch size={14} />箭头表示业务顺序</span>
        <span><ShieldCheck size={14} />状态来自断言核实</span>
        {graph.view?.scope === 'branch' && <><span className="legend-added">蓝色：新增</span><span className="legend-modified">橙色：修改</span><span className="legend-deleted">红色：删除</span></>}
      </div>
      <ReactFlowProvider><ReactFlow
        nodes={nodes}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges<BusinessFlowNode>(changes, current))}
        edges={raw.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault()
          event.stopPropagation()
          onSelect(node.id)
          if (childrenOf(graph, node.id).length > 0) onToggle(node.id)
        }}
        zoomOnDoubleClick={false}
        fitViewOptions={{ padding: 0.18, minZoom: 0.15, maxZoom: 1.05 }}
        minZoom={0.15}
        maxZoom={1.5}
        nodesConnectable={false}
        nodesDraggable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <FitAfterLayout />
        <Background gap={24} size={1.2} color="var(--dot-color)" />
        <MiniMap pannable zoomable nodeColor={(node) => {
          const change = graph.view?.nodeChanges[node.id]?.kind
          return change === 'added' ? '#60a5fa' : change === 'modified' ? '#fb923c' : change === 'deleted' ? '#fb7185' : '#64748b'
        }} />
        <Controls showInteractive={false} />
      </ReactFlow></ReactFlowProvider>
    </div>
  )
}

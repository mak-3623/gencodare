import React, { useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlow, Background, Controls, MarkerType, MiniMap, type Edge, type Node, type NodeMouseHandler, type EdgeMouseHandler } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import './styles.css'

type Concept = { id: string; name: string; short_description: string }
type Relation = { from: string; to: string; reason: string }
type Graph = { nodes: Concept[]; edges: Relation[] }

const layout = (graph: Graph) => {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 85, nodesep: 38, marginx: 40, marginy: 40 })
  graph.nodes.forEach(n => g.setNode(n.id, { width: 210, height: 70 }))
  graph.edges.forEach(e => g.setEdge(e.from, e.to))
  dagre.layout(g)
  const nodes: Node[] = graph.nodes.map(n => {
    const p = g.node(n.id)
    return { id: n.id, data: { label: n.name, description: n.short_description }, position: { x: p.x - 105, y: p.y - 35 }, className: 'concept-node' }
  })
  const edges: Edge[] = graph.edges.map((e, index) => ({ id: `${e.from}-${e.to}-${index}`, source: e.from, target: e.to, label: '', data: { reason: e.reason }, markerEnd: { type: MarkerType.ArrowClosed, color: '#8a8a8a' }, style: { stroke: '#a3a3a3', strokeWidth: 1.4 } }))
  return { nodes, edges }
}

function Upload({ onGraph }: { onGraph: (graph: Graph) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [pasteMode, setPasteMode] = useState(false)
  const [text, setText] = useState('')
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!file && !text.trim()) return setError('Add a PDF or paste your course material to continue.')
    setError(''); setStage('Extracting concepts…')
    try {
      const form = new FormData(); if (file) form.append('file', file); if (text.trim()) form.append('text', text.trim())
      const conceptsResponse = await fetch('/extract-concepts', { method: 'POST', body: form })
      if (!conceptsResponse.ok) throw new Error((await conceptsResponse.json()).detail || 'Could not extract concepts.')
      const nodes: Concept[] = await conceptsResponse.json()
      setStage('Mapping dependencies…')
      const edgesResponse = await fetch('/extract-edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concepts: nodes }) })
      if (!edgesResponse.ok) throw new Error((await edgesResponse.json()).detail || 'Could not map dependencies.')
      onGraph({ nodes, edges: await edgesResponse.json() })
    } catch (e) { setStage(null); setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') }
  }
  if (stage) return <main className="loading"><span className="spinner" /><p>{stage}</p><small>This may take a moment.</small></main>
  return <main className="landing"><section className="upload-card"><h1>PathMind</h1><p className="subtitle">Turn your course material into a concept map</p>
    {!pasteMode ? <><label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files[0] ?? null) }}><input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /><span>{file ? file.name : 'Drop a PDF here, or choose a file'}</span><small>PDF files only</small></label><button className="text-button" onClick={() => setPasteMode(true)}>Paste text instead</button></> : <><textarea autoFocus placeholder="Paste your notes, syllabus, or course material here…" value={text} onChange={e => setText(e.target.value)} /><button className="text-button" onClick={() => setPasteMode(false)}>Upload a PDF instead</button></>}
    {error && <p className="error">{error}</p>}<button className="primary" onClick={submit}>Generate Graph</button></section></main>
}

function GraphView({ graph, onReset }: { graph: Graph; onReset: () => void }) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => layout(graph), [graph])
  const [selected, setSelected] = useState<{ title: string; body: string } | null>(null)
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => setSelected({ title: String(node.data.label), body: String(node.data.description) }), [])
  const onEdgeClick: EdgeMouseHandler = useCallback((_, edge) => setSelected({ title: 'Why this connection?', body: String(edge.data?.reason ?? '') }), [])
  return <div className="graph-page"><header><strong>PathMind</strong><button onClick={onReset}>New Upload</button></header><div className="canvas"><ReactFlow nodes={initialNodes} edges={initialEdges} fitView minZoom={0.2} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick}><Background gap={22} size={1} color="#e8e8e8" /><Controls showInteractive={false} /><MiniMap zoomable pannable nodeColor="#f7f7f7" maskColor="rgba(250,250,250,.72)" /></ReactFlow></div>{selected && <aside><button className="close" onClick={() => setSelected(null)}>×</button><h2>{selected.title}</h2><p>{selected.body}</p></aside>}</div>
}

function App() { const [graph, setGraph] = useState<Graph | null>(null); return graph ? <GraphView graph={graph} onReset={() => setGraph(null)} /> : <Upload onGraph={setGraph} /> }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

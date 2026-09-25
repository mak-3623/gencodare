import React, { useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlow, Background, Controls, MarkerType, MiniMap, type Edge, type Node, type NodeMouseHandler, type EdgeMouseHandler } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import './styles.css'

type Concept = { id: string; name: string; short_description: string }
type Relation = { from: string; to: string; reason: string }
type Graph = { nodes: Concept[]; edges: Relation[] }
type Status = 'known' | 'gap' | 'unknown'
type QuizQuestion = { concept_id: string; question: string; options: string[] }
type PathStep = { concept_id: string; priority: 'skip' | 'review' | 'gap' | 'new'; reason: string }

async function apiError(response: Response) {
  const body = await response.text()
  try {
    const parsed = JSON.parse(body) as { detail?: string }
    return parsed.detail || `Request failed (${response.status}).`
  } catch {
    return body.trim() || `Request failed (${response.status}). Check that the backend is running, then try again.`
  }
}

const layout = (graph: Graph) => {
  const dag = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  dag.setGraph({ rankdir: 'TB', ranksep: 85, nodesep: 38, marginx: 40, marginy: 40 })
  graph.nodes.forEach(node => dag.setNode(node.id, { width: 210, height: 70 }))
  graph.edges.forEach(edge => dag.setEdge(edge.from, edge.to))
  dagre.layout(dag)
  return {
    nodes: graph.nodes.map(node => { const p = dag.node(node.id); return { id: node.id, data: { label: node.name, description: node.short_description }, position: { x: p.x - 105, y: p.y - 35 }, className: 'concept-node' } as Node }),
    edges: graph.edges.map((edge, index) => ({ id: `${edge.from}-${edge.to}-${index}`, source: edge.from, target: edge.to, data: { reason: edge.reason }, markerEnd: { type: MarkerType.ArrowClosed, color: '#8a8a8a' }, style: { stroke: '#a3a3a3', strokeWidth: 1.4 } } as Edge)),
  }
}

function Loading({ label }: { label: string }) { return <main className="loading"><span className="spinner" /><p>{label}</p><small>This may take a moment.</small></main> }

function Upload({ onGraph }: { onGraph: (graph: Graph) => void }) {
  const [file, setFile] = useState<File | null>(null), [pasteMode, setPasteMode] = useState(false), [text, setText] = useState(''), [stage, setStage] = useState<string | null>(null), [error, setError] = useState('')
  const submit = async () => { if (!file && !text.trim()) return setError('Add a PDF or paste your course material to continue.'); setError(''); setStage('Extracting concepts…'); try { const form = new FormData(); if (file) form.append('file', file); if (text.trim()) form.append('text', text.trim()); const conceptsResponse = await fetch('/extract-concepts', { method: 'POST', body: form }); if (!conceptsResponse.ok) throw new Error(await apiError(conceptsResponse)); const nodes: Concept[] = await conceptsResponse.json(); setStage('Mapping dependencies…'); const edgesResponse = await fetch('/extract-edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concepts: nodes }) }); if (!edgesResponse.ok) throw new Error(await apiError(edgesResponse)); onGraph({ nodes, edges: await edgesResponse.json() }) } catch (e) { setStage(null); setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.') } }
  if (stage) return <Loading label={stage} />
  return <main className="landing"><section className="upload-card"><h1>PathMind</h1><p className="subtitle">Turn your course material into a concept map</p>{!pasteMode ? <><label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files[0] ?? null) }}><input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /><span>{file ? file.name : 'Drop a PDF here, or choose a file'}</span><small>PDF files only</small></label><button className="text-button" onClick={() => setPasteMode(true)}>Paste text instead</button></> : <><textarea autoFocus placeholder="Paste your notes, syllabus, or course material here…" value={text} onChange={e => setText(e.target.value)} /><button className="text-button" onClick={() => setPasteMode(false)}>Upload a PDF instead</button></>}{error && <p className="error">{error}</p>}<button className="primary" onClick={submit}>Generate Graph</button></section></main>
}

function QuizScreen({ questions, onDone }: { questions: QuizQuestion[]; onDone: (answers: { concept_id: string; selected_index: number }[]) => void }) {
  const [index, setIndex] = useState(0), [selected, setSelected] = useState<number | null>(null), [answers, setAnswers] = useState<{ concept_id: string; selected_index: number }[]>([]); const q = questions[index]
  const next = () => { if (selected === null) return; const updated = [...answers, { concept_id: q.concept_id, selected_index: selected }]; if (index === questions.length - 1) onDone(updated); else { setAnswers(updated); setIndex(index + 1); setSelected(null) } }
  return <main className="quiz-page"><section className="quiz-card"><div className="quiz-progress"><span>Question {index + 1} of {questions.length}</span><div><i style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div></div><h1>{q.question}</h1><div className="options">{q.options.map((option, i) => <button key={i} className={selected === i ? 'option selected' : 'option'} onClick={() => setSelected(i)}><b>{String.fromCharCode(65 + i)}</b>{option}</button>)}</div><button className="primary" disabled={selected === null} onClick={next}>{index === questions.length - 1 ? 'See My Learning Path' : 'Next'}</button></section></main>
}

function GraphView({ graph, statuses, path, onReset, onQuiz }: { graph: Graph; statuses: Record<string, Status>; path: PathStep[]; onReset: () => void; onQuiz: () => void }) {
  const { nodes: baseNodes, edges } = useMemo(() => layout(graph), [graph]); const [selected, setSelected] = useState<{ title: string; body: string; status: Status } | null>(null), [view, setView] = useState<'graph' | 'path'>('graph')
  const nodes = useMemo(() => baseNodes.map(node => ({ ...node, className: `concept-node status-${statuses[node.id] ?? 'unknown'}`, data: { ...node.data, status: statuses[node.id] ?? 'unknown' } })), [baseNodes, statuses])
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => setSelected({ title: String(node.data.label), body: String(node.data.description), status: (node.data.status ?? 'unknown') as Status }), [])
  const onEdgeClick: EdgeMouseHandler = useCallback((_, edge) => setSelected({ title: 'Why this connection?', body: String(edge.data?.reason ?? ''), status: 'unknown' }), [])
  const names = Object.fromEntries(graph.nodes.map(node => [node.id, node.name])); const statusLabels: Record<Status, string> = { known: 'Known', gap: 'Needs review', unknown: 'Not yet assessed' }
  return <div className="graph-page"><header><strong>PathMind</strong><div className="header-actions"><button className="header-primary" onClick={onQuiz}>{Object.keys(statuses).length ? 'Retake Quiz' : 'Take Diagnostic Quiz'}</button><button onClick={onReset}>New Upload</button></div></header><nav className="view-toggle"><button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>Graph View</button>{path.length > 0 && <button className={view === 'path' ? 'active' : ''} onClick={() => setView('path')}>My Learning Path</button>}</nav>{view === 'graph' ? <div className="canvas"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick}><Background gap={22} size={1} color="#e8e8e8" /><Controls showInteractive={false} /><MiniMap zoomable pannable nodeColor="#f7f7f7" maskColor="rgba(250,250,250,.72)" /></ReactFlow></div> : <main className="path-view"><section><p className="eyebrow">Personalized roadmap</p><h1>Your learning path</h1>{path.map((step, i) => <article className="path-item" key={step.concept_id}><span className="step-number">{i + 1}</span><div><div className="path-title"><h2>{names[step.concept_id]}</h2><span className={`tag tag-${step.priority}`}>{step.priority === 'gap' ? 'Gap' : step.priority === 'new' ? 'New' : step.priority === 'skip' ? 'Known' : 'Review'}</span></div><p>{step.reason}</p></div></article>)}</section></main>}{selected && <aside><button className="close" onClick={() => setSelected(null)}>×</button><h2>{selected.title}</h2><p>{selected.body}</p><span className={`status-label status-${selected.status}`}>{statusLabels[selected.status]}</span></aside>}</div>
}

function App() {
  const [graph, setGraph] = useState<Graph | null>(null), [questions, setQuestions] = useState<QuizQuestion[] | null>(null), [statuses, setStatuses] = useState<Record<string, Status>>({}), [path, setPath] = useState<PathStep[]>([]), [loading, setLoading] = useState<string | null>(null), [error, setError] = useState('')
  const requestQuiz = async () => { if (!graph) return; setError(''); setLoading('Generating your quiz…'); try { const r = await fetch('/generate-quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) }); if (!r.ok) throw new Error(await apiError(r)); setQuestions(await r.json()) } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate the quiz.') } finally { setLoading(null) } }
  const finishQuiz = async (answers: { concept_id: string; selected_index: number }[]) => { if (!graph) return; setLoading('Personalizing your path…'); try { const evaluation = await fetch('/evaluate-quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) }); if (!evaluation.ok) throw new Error(await apiError(evaluation)); const status = await evaluation.json() as Record<string, Status>; const r = await fetch('/generate-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...graph, status }) }); if (!r.ok) throw new Error(await apiError(r)); setStatuses(status); setPath(await r.json()); setQuestions(null) } catch (e) { setError(e instanceof Error ? e.message : 'Could not personalize the learning path.'); setQuestions(null) } finally { setLoading(null) } }
  if (loading) return <Loading label={loading} />; if (questions) return <QuizScreen questions={questions} onDone={finishQuiz} />
  return graph ? <><GraphView graph={graph} statuses={statuses} path={path} onQuiz={requestQuiz} onReset={() => { setGraph(null); setStatuses({}); setPath([]); setError('') }} />{error && <p className="floating-error">{error}</p>}</> : <Upload onGraph={setGraph} />
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

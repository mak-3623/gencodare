import React, { useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlow, Background, BackgroundVariant, Controls, MarkerType, MiniMap, type Edge, type Node, type NodeMouseHandler, type EdgeMouseHandler } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
// @ts-ignore
import './styles.css'

type Concept = { id: string; name: string; short_description: string; why_it_matters?: string; sources: string[] }
type Relation = { from: string; to: string; reason: string }
type Graph = { nodes: Concept[]; edges: Relation[] }
type Status = 'known' | 'gap' | 'unknown'
type QuizQuestion = { concept_id: string; question: string; options: string[]; correct_index: number; explanation: string }
type RetestQuestion = { concept_id: string; question: string; options: string[]; correct_index: number }
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
    nodes: graph.nodes.map(node => { const p = dag.node(node.id); return { id: node.id, data: { label: node.name, description: node.short_description, whyItMatters: node.why_it_matters ?? '', sources: node.sources }, position: { x: p.x - 105, y: p.y - 35 }, className: 'concept-node' } as Node }),
    edges: graph.edges.map((edge, index) => ({ id: `${edge.from}-${edge.to}-${index}`, source: edge.from, target: edge.to, data: { reason: edge.reason }, markerEnd: { type: MarkerType.ArrowClosed, color: '#8a8a8a' }, style: { stroke: '#a3a3a3', strokeWidth: 1.4 } } as Edge)),
  }
}

function Loading({ label }: { label: string }) { return <main className="loading"><span className="spinner" /><p>{label}</p><small>This may take a moment.</small></main> }

type SourceInput = { id: string; label: string; file?: File; text?: string }

function Upload({ onGraph }: { onGraph: (graph: Graph) => void }) {
  const [sources, setSources] = useState<SourceInput[]>([]), [file, setFile] = useState<File | null>(null), [pasteMode, setPasteMode] = useState(false), [text, setText] = useState(''), [stage, setStage] = useState<string | null>(null), [error, setError] = useState('')
  const pendingSource = (): SourceInput | null => file ? { id: crypto.randomUUID(), label: file.name, file } : text.trim() ? { id: crypto.randomUUID(), label: `Pasted text ${sources.filter(source => source.text).length + 1}`, text: text.trim() } : null
  const addSource = () => { const source = pendingSource(); if (!source) return setError('Choose a PDF or paste text before adding another source.'); setSources(current => [...current, source]); setFile(null); setText(''); setError('') }
  const submit = async () => { const pending = pendingSource(); const activeSources = pending ? [...sources, pending] : sources; if (!activeSources.length) return setError('Add a PDF or paste your course material to continue.'); setError(''); setStage('Extracting concepts…'); try { const lists = await Promise.all(activeSources.map(async source => { const form = new FormData(); form.append('source', source.label); if (source.file) form.append('file', source.file); else form.append('text', source.text ?? ''); const response = await fetch('/extract-concepts', { method: 'POST', body: form }); if (!response.ok) throw new Error(await apiError(response)); return response.json() as Promise<Concept[]> })); const nodes = lists.length === 1 ? lists[0] : await (async () => { setStage('Merging sources…'); const response = await fetch('/merge-concepts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concept_lists: lists }) }); if (!response.ok) throw new Error(await apiError(response)); return response.json() as Promise<Concept[]> })(); setStage('Mapping dependencies…'); const edgeResponse = await fetch('/extract-edges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concepts: nodes }) }); if (!edgeResponse.ok) throw new Error(await apiError(edgeResponse)); onGraph({ nodes, edges: await edgeResponse.json() }) } catch (e) { setStage(null); setError(e instanceof Error ? e.message : "Couldn't process those sources. Try a different PDF or shorter text.") } }
  if (stage) return <Loading label={stage} />
  return <main className="landing"><div className="home-shell"><header className="home-header"><strong>PathMind</strong><span>Concept learning, made clear</span></header><section className="home-intro"><p className="eyebrow">Your learning workspace</p><h1>Understand what to learn next.</h1><p>Bring together your course material and turn it into a concept map, a quick diagnostic, and a focused study path.</p></section><section className="upload-card"><div className="upload-heading"><h2>Add course material</h2><p>Upload PDFs or paste notes. You can combine multiple sources before generating.</p></div>{sources.length > 0 && <div className="source-list">{sources.map(source => <div className="source-row" key={source.id}><span>{source.label}</span><button aria-label={`Remove ${source.label}`} onClick={() => setSources(current => current.filter(item => item.id !== source.id))}>×</button></div>)}</div>}{!pasteMode ? <><label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files[0] ?? null) }}><input type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /><span>{file ? file.name : sources.length ? 'Add another PDF source' : 'Drop a PDF here, or choose a file'}</span><small>Text-based PDF files only</small></label><button className="text-button" onClick={() => setPasteMode(true)}>Paste text instead</button></> : <><textarea autoFocus placeholder="Paste notes, syllabus, or course material here…" value={text} onChange={e => setText(e.target.value)} /><button className="text-button" onClick={() => setPasteMode(false)}>Upload a PDF instead</button></>}{(file || text.trim()) && <button className="add-source" onClick={addSource}>+ Add another source</button>}{error && <p className="error">{error}</p>}<button className="primary" onClick={submit}>Generate Graph{sources.length ? ` from ${sources.length + (pendingSource() ? 1 : 0)} sources` : ''}</button></section><section className="home-steps" aria-label="How PathMind works"><div><span>1</span><p><b>Map concepts</b>Find the ideas and prerequisites in your material.</p></div><div><span>2</span><p><b>Check understanding</b>Take a short diagnostic quiz.</p></div><div><span>3</span><p><b>Follow your path</b>Focus your study where it matters most.</p></div></section></div></main>
}

function QuizScreen({ questions, onDone }: { questions: QuizQuestion[]; onDone: (answers: { concept_id: string; selected_index: number }[]) => void }) {
  const [index, setIndex] = useState(0)
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, number>>({})
  const [checked, setChecked] = useState(false)
  const q = questions[index]
  const selected = selectedByQuestion[index] ?? null
  const isLastQuestion = index === questions.length - 1

  const next = () => {
    if (selected === null) return
    if (!checked) return setChecked(true)
    const answers = questions.map((question, i) => ({ concept_id: question.concept_id, selected_index: selectedByQuestion[i] ?? -1 })).filter(answer => answer.selected_index >= 0)
    if (isLastQuestion) {
      onDone(answers)
      return
    }
    setIndex(index + 1)
    setChecked(false)
  }

  const previous = () => {
    if (index === 0) return
    setIndex(index - 1)
    setChecked(false)
  }

  return <main className="quiz-page"><section className="quiz-card"><div className="quiz-progress"><span>Question {index + 1} of {questions.length}</span><div><i style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div></div><h1>{q.question}</h1><div className="options">{q.options.map((option, i) => <button key={i} disabled={checked} className={`option ${selected === i ? 'selected' : ''} ${checked && i === q.correct_index ? 'correct' : ''} ${checked && selected === i && i !== q.correct_index ? 'incorrect' : ''}`} onClick={() => { setSelectedByQuestion(current => ({ ...current, [index]: i })); if (!checked) setChecked(false) }}><b>{String.fromCharCode(65 + i)}</b>{option}</button>)}</div>{checked && <p className={`answer-feedback ${selected === q.correct_index ? 'is-correct' : 'is-incorrect'}`}><b>{selected === q.correct_index ? 'Correct.' : `Correct answer: ${String.fromCharCode(65 + q.correct_index)}.`}</b> {q.explanation}</p>}<div className="quiz-actions"><button className="secondary-button" disabled={index === 0} onClick={previous}>Back</button><button className="primary" disabled={selected === null} onClick={next}>{!checked ? 'Check Answer' : isLastQuestion ? 'Submit' : 'Next'}</button></div></section></main>
}

function RetestScreen({ question, onAnswer, onClose, onNext, result, loading, isLastQuestion }: { question: RetestQuestion; onAnswer: (selectedIndex: number) => void; onClose: () => void; onNext: () => void; result: { status: Status; message: string } | null; loading: boolean; isLastQuestion: boolean }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [checked, setChecked] = useState(false)

  React.useEffect(() => {
    setSelected(null)
    setChecked(false)
  }, [question])

  const handleSubmit = () => {
    if (result) return onNext()
    if (selected === null) return
    if (!checked) return setChecked(true)
    onAnswer(selected)
  }

  return <main className="quiz-page"><section className="quiz-card"><div className="quiz-progress"><span>Retest</span><div><i style={{ width: '100%' }} /></div></div><h1>{question.question}</h1><div className="options">{question.options.map((option, i) => <button key={i} disabled={loading || !!result} className={`option ${selected === i ? 'selected' : ''} ${checked && i === question.correct_index ? 'correct' : ''} ${checked && selected === i && i !== question.correct_index ? 'incorrect' : ''}`} onClick={() => setSelected(i)}><b>{String.fromCharCode(65 + i)}</b>{option}</button>)}</div>{loading && <p className="answer-feedback is-correct"><b>Checking your answer...</b></p>}{result && <p className={`answer-feedback ${result.status === 'known' ? 'is-correct' : 'is-incorrect'}`}><b>{result.status === 'known' ? 'Correct.' : 'Not quite yet.'}</b> {result.message}</p>}<div className="quiz-actions"><button className="primary" disabled={selected === null || loading} onClick={handleSubmit}>{result ? (isLastQuestion ? 'Close' : 'Next') : checked ? 'Submit' : 'Check Answer'}</button></div></section></main>
}

function GraphView({ graph, statuses, path, onReset, onQuiz, onStatusChange }: { graph: Graph; statuses: Record<string, Status>; path: PathStep[]; onReset: () => void; onQuiz: () => void; onStatusChange: (next: Record<string, Status>) => void }) {
  const { nodes: baseNodes, edges } = useMemo(() => layout(graph), [graph])
  const [selected, setSelected] = useState<{ title: string; body: string; status: Status; sources: string[]; whyItMatters: string } | null>(null)
  const [view, setView] = useState<'graph' | 'path' | 'dashboard'>('graph')
  const [dashboardError, setDashboardError] = useState('')
  const [explanation, setExplanation] = useState<{ concept_id: string; explanation: string; study_tip: string } | null>(null)
  const [viewedConcepts, setViewedConcepts] = useState<Record<string, boolean>>({})
  const [retestQuestions, setRetestQuestions] = useState<RetestQuestion[] | null>(null)
  const [retestIndex, setRetestIndex] = useState(0)
  const [retestResult, setRetestResult] = useState<{ status: Status; message: string } | null>(null)
  const [busyConceptId, setBusyConceptId] = useState<string | null>(null)
  const hasDashboard = Object.keys(statuses).length > 0

  const nodes = useMemo(() => baseNodes.map(node => ({ ...node, className: `concept-node status-${statuses[node.id] ?? 'unknown'}`, data: { ...node.data, status: statuses[node.id] ?? 'unknown' } })), [baseNodes, statuses])
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => setSelected({ title: String(node.data.label), body: String(node.data.description), status: (node.data.status ?? 'unknown') as Status, sources: Array.isArray(node.data.sources) ? node.data.sources.map(String) : [], whyItMatters: String(node.data.whyItMatters ?? '') }), [])
  const onEdgeClick: EdgeMouseHandler = useCallback((_, edge) => setSelected({ title: 'Why this connection?', body: String(edge.data?.reason ?? ''), status: 'unknown', sources: [], whyItMatters: '' }), [])
  const names = Object.fromEntries(graph.nodes.map(node => [node.id, node.name])); const statusLabels: Record<Status, string> = { known: 'Known', gap: 'Needs review', unknown: 'Not yet assessed' }

  const knownConcepts = graph.nodes.filter(node => statuses[node.id] === 'known')
  const gapConcepts = graph.nodes.filter(node => statuses[node.id] === 'gap')
  const totalConcepts = graph.nodes.length
  const masteryPercent = totalConcepts ? Math.round((knownConcepts.length / totalConcepts) * 100) : 0

  const handleExplanation = async (concept: { id: string; name: string; short_description: string }) => {
    setBusyConceptId(concept.id)
    setDashboardError('')
    try {
      const response = await fetch('/concept-explanation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concept_id: concept.id, name: concept.name, description: concept.short_description }) })
      if (!response.ok) throw new Error(await apiError(response))
      const data = await response.json() as { concept_id: string; explanation: string; study_tip: string }
      setExplanation({ ...data, concept_id: data.concept_id || concept.id })
      setViewedConcepts(current => ({ ...current, [concept.id]: true }))
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Could not load the concept explanation.')
    } finally {
      setBusyConceptId(null)
    }
  }

  const currentRetestQuestion = retestQuestions?.[retestIndex] ?? null

  const handleRetestStart = async (concept: { id: string; name: string; short_description: string }) => {
    setBusyConceptId(concept.id)
    setDashboardError('')
    try {
      const response = await fetch('/retest-concept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concept_id: concept.id, name: concept.name, description: concept.short_description }) })
      if (!response.ok) throw new Error(await apiError(response))
      const data = await response.json() as { concept_id: string; questions: RetestQuestion[] }
      setRetestQuestions(data.questions)
      setRetestIndex(0)
      setRetestResult(null)
      setExplanation(null)
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Could not generate a retest question set.')
    } finally {
      setBusyConceptId(null)
    }
  }

  const handleRetestAnswer = async (selectedIndex: number) => {
    if (!currentRetestQuestion) return
    setBusyConceptId(currentRetestQuestion.concept_id)
    try {
      const response = await fetch('/evaluate-retest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concept_id: currentRetestQuestion.concept_id, selected_index: selectedIndex, correct_index: currentRetestQuestion.correct_index }) })
      if (!response.ok) throw new Error(await apiError(response))
      const data = await response.json() as { status: 'known' | 'gap' }
      const nextStatus = data.status === 'known' ? 'known' : 'gap'
      const nextStatuses = { ...statuses } as Record<string, Status>
      nextStatuses[currentRetestQuestion.concept_id] = nextStatus
      onStatusChange(nextStatuses)
      setRetestResult({ status: nextStatus, message: nextStatus === 'known' ? 'Nice work — this concept is now marked as known.' : 'That one still needs a little more review. Try the explanation again or keep studying.' })
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Could not evaluate that retest.')
    } finally {
      setBusyConceptId(null)
    }
  }

  if (currentRetestQuestion) {
    return <RetestScreen question={currentRetestQuestion} onAnswer={handleRetestAnswer} onClose={() => { setRetestQuestions(null); setRetestIndex(0); setRetestResult(null); setView('dashboard') }} onNext={() => {
      if (retestQuestions && retestIndex < retestQuestions.length - 1) {
        setRetestIndex(index => index + 1)
        setRetestResult(null)
        return
      }
      setRetestQuestions(null)
      setRetestIndex(0)
      setRetestResult(null)
      setView('dashboard')
    }} result={retestResult} loading={busyConceptId === currentRetestQuestion.concept_id} isLastQuestion={retestIndex === (retestQuestions?.length ?? 1) - 1} />
  }

  let panel
  if (view === 'graph') {
    panel = <div className="canvas"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick}><Background variant={BackgroundVariant.Lines} gap={28} size={1} color="#eeeeee" /><Controls showInteractive={false} /><MiniMap zoomable pannable nodeColor="#f7f7f7" maskColor="rgba(250,250,250,.72)" /></ReactFlow></div>
  } else if (view === 'path') {
    panel = <main className="path-view"><section><p className="eyebrow">Personalized roadmap</p><h1>Your learning path</h1>{path.map((step, i) => <article className="path-item" key={step.concept_id}><span className="step-number">{i + 1}</span><div><div className="path-title"><h2>{names[step.concept_id]}</h2><span className={`tag tag-${step.priority}`}>{step.priority === 'gap' ? 'Gap' : step.priority === 'new' ? 'New' : step.priority === 'skip' ? 'Known' : 'Review'}</span></div><p>{step.reason}</p></div></article>)}</section></main>
  } else {
    panel = <main className="path-view dashboard-view"><section className="dashboard-shell"><div className="dashboard-summary"><div className="summary-card"><span className="eyebrow">Overall progress</span><h1>{masteryPercent}% concepts mastered</h1><div className="progress-bar"><i style={{ width: `${masteryPercent}%` }} /></div></div><div className="stat-grid"><div className="stat-card"><span>Total</span><strong>{totalConcepts}</strong></div><div className="stat-card"><span>Known</span><strong>{knownConcepts.length}</strong></div><div className="stat-card"><span>Gap</span><strong>{gapConcepts.length}</strong></div></div></div>{dashboardError && <p className="dashboard-error">{dashboardError}</p>}<div className="dashboard-section"><h2>Scored Well</h2>{knownConcepts.length ? <div className="concept-chip-list">{knownConcepts.map(concept => <div key={concept.id} className="concept-chip concept-chip-known">{concept.name}</div>)}</div> : <p className="empty-state">No concepts have been marked as known yet.</p>}</div><div className="dashboard-section"><h2>Needs Improvement</h2>{gapConcepts.length ? <div className="concept-card-list">{gapConcepts.map(concept => <article key={concept.id} className="concept-card"><div className="concept-card-header"><h3>{concept.name}</h3>{viewedConcepts[concept.id] && <span className="mini-tag">Viewed</span>}</div>{explanation && explanation.concept_id === concept.id ? <div className="explanation-panel"><p>{explanation.explanation}</p><small><strong>Study tip:</strong> {explanation.study_tip}</small></div> : null}<div className="concept-card-actions"><button className="secondary-button" disabled={busyConceptId === concept.id} onClick={() => handleExplanation(concept)}>{busyConceptId === concept.id ? 'Preparing…' : 'Learn This'}</button>{viewedConcepts[concept.id] && <button className="primary small-button" onClick={() => handleRetestStart(concept)}>Retest</button>}</div></article>)}</div> : <p className="empty-state">No weak concepts right now. Nice work.</p>}</div></section></main>
  }

  return <div className="graph-page"><header><strong>PathMind</strong><div className="header-actions"><button className="header-primary" onClick={onQuiz}>{Object.keys(statuses).length ? 'Retake Quiz' : 'Take Diagnostic Quiz'}</button><button onClick={onReset}>New Upload</button></div></header><nav className="view-toggle"><button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>Graph View</button>{path.length > 0 && <button className={view === 'path' ? 'active' : ''} onClick={() => setView('path')}>My Learning Path</button>}{hasDashboard && <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>}</nav>{panel}{selected && <aside><button className="close" onClick={() => setSelected(null)}>×</button><h2>{selected.title}</h2><p>{selected.body}</p>{selected.whyItMatters && <p className="learn-first"><b>Why it matters</b>{selected.whyItMatters}</p>}{selected.sources.length > 0 && <p className="source-detail"><b>Sources</b>{selected.sources.join(', ')}</p>}<span className={`status-label status-${selected.status}`}>{statusLabels[selected.status]}</span></aside>}</div>
}

function App() {
  const [graph, setGraph] = useState<Graph | null>(null), [questions, setQuestions] = useState<QuizQuestion[] | null>(null), [statuses, setStatuses] = useState<Record<string, Status>>({}), [path, setPath] = useState<PathStep[]>([]), [loading, setLoading] = useState<string | null>(null), [error, setError] = useState('')
  const requestQuiz = async () => { if (!graph) return; setError(''); setLoading('Generating your quiz…'); try { const r = await fetch('/generate-quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) }); if (!r.ok) throw new Error(await apiError(r)); setQuestions(await r.json()) } catch (e) { setError(e instanceof Error ? e.message : 'Could not generate the quiz.') } finally { setLoading(null) } }
  const finishQuiz = async (answers: { concept_id: string; selected_index: number }[]) => { if (!graph) return; setLoading('Personalizing your path…'); try { const evaluation = await fetch('/evaluate-quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) }); if (!evaluation.ok) throw new Error(await apiError(evaluation)); const status = await evaluation.json() as Record<string, Status>; const r = await fetch('/generate-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...graph, status }) }); if (!r.ok) throw new Error(await apiError(r)); setStatuses(status); setPath(await r.json()); setQuestions(null) } catch (e) { setError(e instanceof Error ? e.message : 'Could not personalize the learning path.'); setQuestions(null) } finally { setLoading(null) } }
  if (loading) return <Loading label={loading} />; if (questions) return <QuizScreen questions={questions} onDone={finishQuiz} />
  return graph ? <><GraphView graph={graph} statuses={statuses} path={path} onQuiz={requestQuiz} onStatusChange={setStatuses} onReset={() => { setGraph(null); setStatuses({}); setPath([]); setError(''); }} />{error && <p className="floating-error">{error}</p>}</> : <Upload onGraph={setGraph} />
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

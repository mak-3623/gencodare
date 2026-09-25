# PathMind

PathMind is an AI-assisted learning prototype. It converts pasted course notes or a text-based PDF into a prerequisite concept graph, uses a short diagnostic quiz to assess the learner, and creates a dependency-aware study roadmap.

The interface is intentionally minimal: neutral surfaces, subtle borders, a single muted blue accent, and no decorative effects. It is designed for a laptop demo.

## Prototype capabilities

- Upload a selectable-text PDF or paste notes.
- Extract a comprehensive inventory of atomic course concepts.
- Build a directed prerequisite graph with explanations for each edge.
- Explore the graph with pan, zoom, minimap, node descriptions, and edge reasons.
- Take a one-question-at-a-time diagnostic quiz of up to 10 questions.
- See concepts marked as known, needs review, or not yet assessed.
- View a personalized, ordered study path and retake the quiz without re-uploading material.

## Stack

| Area            | Technology                                                 |
| --------------- | ---------------------------------------------------------- |
| Frontend        | React 18, TypeScript, Vite                                 |
| Styling         | Tailwind CSS and focused custom CSS                        |
| Graph rendering | [React Flow](https://reactflow.dev/) / `@xyflow/react`     |
| Graph layout    | Dagre / `@dagrejs/dagre`                                   |
| Backend         | Python, FastAPI, Pydantic                                  |
| PDF parsing     | PyMuPDF / `fitz`                                           |
| AI              | Gemini API by default; Anthropic Messages API is supported |

## User workflow

1. Upload course material or paste notes.
2. Select **Generate Graph**.
3. PathMind extracts concepts and maps prerequisite relationships.
4. Select nodes for descriptions and edges for dependency explanations.
5. Select **Take Diagnostic Quiz** and answer questions one at a time.
6. After the last answer, PathMind evaluates the quiz and builds a personalized path.
7. Inspect the colored graph, or switch to **My Learning Path** for a roadmap.
8. Use **Retake Quiz** to reassess without uploading again.

## Technical workflow

```text
PDF / pasted course material
        |
        v
FastAPI text extraction (PyMuPDF for PDFs)
        |
        v
LLM concept extraction
        |
        v
LLM prerequisite edges -> duplicate/invalid/cycle filtering
        |
        v
Dagre layout + React Flow interactive graph
        |
        +--> diagnostic quiz generation (maximum 10 questions)
        |          |
        |          v
        |   answer evaluation -> known / gap / unknown
        |          |
        +----------v
        topological sort + LLM personalization
                    |
                    v
        color-coded graph and learning roadmap
```

### Graph generation

`POST /extract-concepts` accepts multipart `text` or a PDF `file`. PDFs are read with PyMuPDF; a PDF with no selectable text receives a friendly error. The LLM is prompted to preserve definitions, components, mechanisms, methods, formulas/principles, uses, and outcomes.

`POST /extract-edges` receives concepts and requests `{ from, to, reason }` prerequisites. The backend removes invalid IDs, self-links, duplicate links, and cycle-forming links. The LLM is prompted to produce a single genuine foundational root and a connected learning DAG.

The frontend runs Dagre to create a top-to-bottom layout and React Flow supplies zooming, panning, selection, and a minimap.

### Diagnostic and adaptive path

`POST /generate-quiz` receives the graph. For graphs up to 10 concepts, every concept is quizzed. Larger graphs prioritize source/leaf concepts and cap the quiz at 10 questions. Each question has exactly four options and one answer; answer indexes never leave the backend.

`POST /evaluate-quiz` compares selected indexes to the current in-memory quiz answer key. Correct concepts become `known`, incorrect ones become `gap`, and concepts outside the capped quiz become `unknown`.

`POST /generate-path` starts with a server-side topological sort. The LLM recommends an ordered path with `skip`, `review`, `gap`, or `new` labels. The API validates every prerequisite ordering; if the LLM violates an edge, it returns the safe server-side order while preserving valid AI recommendations.

## API summary

| Endpoint                 | Input                          | Output                           |
| ------------------------ | ------------------------------ | -------------------------------- |
| `POST /extract-concepts` | multipart `text` or PDF `file` | concept list                     |
| `POST /extract-edges`    | `{ concepts }`                 | dependency edge list             |
| `POST /build-graph`      | multipart `text` or PDF `file` | `{ nodes, edges }`               |
| `POST /generate-quiz`    | `{ nodes, edges }`             | quiz questions (answers omitted) |
| `POST /evaluate-quiz`    | `{ answers }`                  | status map                       |
| `POST /generate-path`    | `{ nodes, edges, status }`     | ordered learning steps           |

## Run locally

### Configure Gemini

```powershell
cd "D:\Nilavan\Web dev\hacks\gendacore\backend"
Copy-Item .env.example .env
```

Put your own key in `backend/.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
```

Gemini is selected if `GEMINI_API_KEY` is set. Anthropic can instead be configured with `ANTHROPIC_API_KEY`; Gemini has priority if both exist. Never commit a real key or put it in `.env.example`.

### Start the backend

```powershell
cd "D:\Nilavan\Web dev\hacks\gendacore\backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The API health check is at `http://localhost:8000/health`.

### Start the frontend

In another terminal:

```powershell
cd "D:\Nilavan\Web dev\hacks\gendacore\frontend"
npm install
npm run dev
```

Open Vite's URL (normally `http://localhost:5173`). Vite proxies the graph and quiz API calls to the backend on port 8000.

### Verify a production frontend build

```powershell
cd "D:\Nilavan\Web dev\hacks\gendacore\frontend"
npm run build
```

## Reliability and current limitations

- Model responses have Markdown code fences stripped and are parsed defensively. Invalid structured output is retried; transient Gemini capacity/rate-limit responses use short backoff retries.
- Quiz answer keys live only in FastAPI process memory. This supports a single local demo, not multiple users or persistence. Production should use a session ID and database/Redis storage.
- Scanned PDFs without an OCR text layer are not supported yet.
- Concept coverage and recommendations depend on the source material and the selected model.
- Authentication, saved graphs, user accounts, analytics, and production deployment are outside this prototype.

## Project structure

```text
gendacore/
├── backend/
│   ├── app/main.py          # FastAPI routes, AI integration, validation
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/main.tsx         # Graph, quiz, and learning-path React state/UI
│   ├── src/styles.css       # Minimal visual system
│   ├── vite.config.ts       # Development API proxy
│   └── package.json
└── README.md
```

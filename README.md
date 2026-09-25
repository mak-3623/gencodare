# PathMind

Turn course material into a prerequisite concept map.

## Run locally

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000
```

Set either `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `backend/.env`. Gemini is used when both are present.

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). The Vite dev server proxies API requests to port 8000.

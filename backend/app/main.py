import json
import os
import re
import asyncio
from io import BytesIO
from typing import Annotated, Any

import fitz
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="PathMind API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Concept(BaseModel):
    id: str
    name: str
    short_description: str


class Edge(BaseModel):
    from_: str = Field(alias="from")
    to: str
    reason: str

    model_config = {"populate_by_name": True}


class EdgeRequest(BaseModel):
    concepts: list[Concept]


def clean_json(value: str) -> Any:
    """Extract and decode JSON even when a model has wrapped it in a code fence."""
    value = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", value.strip(), flags=re.I)
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        start = min((i for i in (value.find("["), value.find("{")) if i >= 0), default=-1)
        if start < 0:
            raise
        decoder = json.JSONDecoder()
        return decoder.raw_decode(value[start:])[0]


async def ask_llm(prompt: str) -> Any:
    """Use Gemini or Anthropic and retry once when the returned JSON is malformed."""
    provider = "gemini" if os.getenv("GEMINI_API_KEY") else "anthropic" if os.getenv("ANTHROPIC_API_KEY") else None
    if not provider:
        raise HTTPException(503, "No AI provider is configured. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to backend/.env.")

    last_error: Exception | None = None
    async with httpx.AsyncClient(timeout=75) as client:
        for attempt in range(3):
            retry_note = "\nYour previous output was invalid. Return strict JSON only." if attempt else ""
            try:
                if provider == "gemini":
                    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
                    response = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                        params={"key": os.environ["GEMINI_API_KEY"]},
                        json={"contents": [{"parts": [{"text": prompt + retry_note}]}], "generationConfig": {"responseMimeType": "application/json"}},
                    )
                    response.raise_for_status()
                    text = response.json()["candidates"][0]["content"]["parts"][0]["text"]
                else:
                    model = os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest")
                    response = await client.post(
                        "https://api.anthropic.com/v1/messages",
                        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                        json={"model": model, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt + retry_note}]},
                    )
                    response.raise_for_status()
                    text = response.json()["content"][0]["text"]
                return clean_json(text)
            except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                # Capacity and rate-limit errors are normally brief. Retry these
                # before surfacing the provider's message to the student.
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {429, 500, 502, 503, 504} and attempt < 2:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                break
    if isinstance(last_error, httpx.HTTPStatusError):
        try:
            detail = last_error.response.json().get("error", {}).get("message", "")
        except ValueError:
            detail = ""
        message = f"Gemini request failed ({last_error.response.status_code})" if provider == "gemini" else f"Anthropic request failed ({last_error.response.status_code})"
        raise HTTPException(502, f"{message}: {detail or 'check the API key, selected model, and provider access.'}") from last_error
    raise HTTPException(502, "The AI provider returned an unreadable response. Please try again.") from last_error


async def get_source_text(text: str | None, file: UploadFile | None) -> str:
    if text and text.strip():
        return text.strip()
    if not file:
        raise HTTPException(422, "Paste some course material or upload a PDF.")
    if file.content_type not in {"application/pdf", "application/x-pdf"} and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(422, "Please upload a PDF file.")
    try:
        document = fitz.open(stream=BytesIO(await file.read()), filetype="pdf")
        extracted = "\n".join(page.get_text() for page in document).strip()
    except Exception as exc:
        raise HTTPException(422, "This PDF could not be read.") from exc
    if not extracted:
        raise HTTPException(422, "No selectable text was found in this PDF. Try pasting the material instead.")
    return extracted


async def concepts_from_source(source: str) -> list[Concept]:
    prompt = '''From the following course material, extract the core concepts a student needs to learn. Return ONLY valid JSON: a list of objects with exactly {id, name, short_description}. IDs should be short lowercase slugs. Concepts must be atomic, distinct, and non-overlapping. Keep descriptions under 28 words.\n\nCOURSE MATERIAL:\n''' + source[:70000]
    raw = await ask_llm(prompt)
    try:
        return [Concept.model_validate(item) for item in raw]
    except Exception as exc:
        raise HTTPException(502, "The AI response did not contain valid concepts. Please try again.") from exc


async def edges_from_concepts(concepts: list[Concept]) -> list[Edge]:
    prompt = """Given this list of concepts, determine prerequisite relationships. Return ONLY valid JSON: a list of objects {from, to, reason}. 'from' must be understood before 'to'; all IDs must be from the supplied list; reason is one clear sentence. Do not create cycles, duplicate edges, or an edge from a concept to itself.\n\nCONCEPTS:\n""" + json.dumps([item.model_dump() for item in concepts])
    raw = await ask_llm(prompt)
    ids = {item.id for item in concepts}
    try:
        edges = [Edge.model_validate(item) for item in raw]
    except Exception as exc:
        raise HTTPException(502, "The AI response did not contain valid dependencies. Please try again.") from exc
    valid: list[Edge] = []
    seen: set[tuple[str, str]] = set()
    adjacency: dict[str, set[str]] = {concept_id: set() for concept_id in ids}

    def would_create_cycle(source: str, target: str) -> bool:
        stack = [target]
        visited: set[str] = set()
        while stack:
            current = stack.pop()
            if current == source:
                return True
            if current not in visited:
                visited.add(current)
                stack.extend(adjacency[current])
        return False

    for edge in edges:
        key = (edge.from_, edge.to)
        if edge.from_ in ids and edge.to in ids and edge.from_ != edge.to and key not in seen and not would_create_cycle(edge.from_, edge.to):
            valid.append(edge)
            seen.add(key)
            adjacency[edge.from_].add(edge.to)
    return valid


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/extract-concepts", response_model=list[Concept])
async def extract_concepts(text: Annotated[str | None, Form()] = None, file: Annotated[UploadFile | None, File()] = None):
    return await concepts_from_source(await get_source_text(text, file))


@app.post("/extract-edges", response_model=list[Edge])
async def extract_edges(request: EdgeRequest):
    return await edges_from_concepts(request.concepts)


@app.post("/build-graph")
async def build_graph(text: Annotated[str | None, Form()] = None, file: Annotated[UploadFile | None, File()] = None):
    concepts = await concepts_from_source(await get_source_text(text, file))
    edges = await edges_from_concepts(concepts)
    return {"nodes": [item.model_dump() for item in concepts], "edges": [item.model_dump(by_alias=True) for item in edges]}

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
    why_it_matters: str = ""
    sources: list[str] = Field(default_factory=list)


class Edge(BaseModel):
    from_: str = Field(alias="from")
    to: str
    reason: str

    model_config = {"populate_by_name": True}


class EdgeRequest(BaseModel):
    concepts: list[Concept]


class MergeConceptsRequest(BaseModel):
    concept_lists: list[list[Concept]]


class GraphRequest(BaseModel):
    nodes: list[Concept]
    edges: list[Edge]


class QuizQuestion(BaseModel):
    concept_id: str
    question: str
    options: list[str]
    correct_index: int
    explanation: str


class QuizResponseQuestion(BaseModel):
    concept_id: str
    question: str
    options: list[str]
    correct_index: int
    explanation: str


class QuizAnswer(BaseModel):
    concept_id: str
    selected_index: int


class QuizAnswerRequest(BaseModel):
    answers: list[QuizAnswer]


class PathStep(BaseModel):
    concept_id: str
    priority: str
    reason: str


class PathRequest(GraphRequest):
    status: dict[str, str]


class ConceptExplanationRequest(BaseModel):
    concept_id: str
    name: str = ""
    description: str = ""


class ConceptExplanationResponse(BaseModel):
    concept_id: str
    explanation: str
    study_tip: str


class RetestConceptRequest(BaseModel):
    concept_id: str
    name: str = ""
    description: str = ""


class RetestQuestionResponse(BaseModel):
    concept_id: str
    question: str
    options: list[str]
    correct_index: int


class RetestConceptResponse(BaseModel):
    concept_id: str
    questions: list[RetestQuestionResponse]


class RetestEvaluationRequest(BaseModel):
    concept_id: str
    selected_index: int
    correct_index: int


# This is intentionally short-lived, in-memory quiz state for a local demo.
# A production deployment would associate this with a user/session in a database.
latest_quiz: dict[str, QuizQuestion] = {}
latest_quiz_concepts: set[str] = set()


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


async def ask_llm(prompt: str, response_schema: dict[str, Any] | None = None) -> Any:
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
                    generation_config: dict[str, Any] = {"responseMimeType": "application/json"}
                    if response_schema:
                        generation_config["responseSchema"] = response_schema
                    response = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                        params={"key": os.environ["GEMINI_API_KEY"]},
                        json={"contents": [{"parts": [{"text": prompt + retry_note}]}], "generationConfig": generation_config},
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
                # Models occasionally wrap or truncate structured output. Give
                # malformed JSON one explicit correction attempt as promised.
                if not isinstance(exc, httpx.HTTPError) and attempt < 1:
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
    length_guidance = "Aim for 12–25 concepts" if len(source) > 1800 else "Aim for 8–16 concepts"
    prompt = f'''From the following course material, build a comprehensive learning-concept inventory. Return ONLY valid JSON: a list of objects with exactly {{id, name, short_description, why_it_matters}}. IDs should be short lowercase slugs.

Include every meaningful learnable idea in the material: key definitions, entities/components, mechanisms and stages, methods/algorithms, formulas or principles, and explicitly discussed uses or outcomes. Do not collapse several named ideas into one vague umbrella concept just to make a smaller graph. Concepts must still be atomic, distinct, and non-overlapping; omit only trivial examples, repetition, and incidental wording. {length_guidance}, adjusting upward for genuinely dense material.

Include one genuinely foundational real concept broad enough to be the single starting point of the learning path; do not split closely related basics into disconnected foundations. Keep each description under 28 words. why_it_matters must be one specific, student-friendly sentence explaining the practical or conceptual value of learning that concept; do not mention graph order or use generic wording. Before answering, silently check that each major section of the source has representation in the list.\n\nCOURSE MATERIAL:\n''' + source[:70000]
    raw = await ask_llm(prompt)
    try:
        return [Concept.model_validate(item) for item in raw]
    except Exception as exc:
        raise HTTPException(502, "The AI response did not contain valid concepts. Please try again.") from exc


async def merge_concept_lists(concept_lists: list[list[Concept]]) -> list[Concept]:
    prompt = """You are given concept lists extracted from multiple course sources. Some concepts are duplicates with different names, such as 'Recursion' and 'Recursive Functions'. Merge semantic duplicates into one concept while retaining distinct concepts. Combine descriptions concisely and preserve every original source label.

Return ONLY valid JSON: a single deduplicated list of objects {id, name, short_description, why_it_matters, sources}. IDs must be unique lowercase slugs; sources must be a non-empty list of source labels. why_it_matters must retain or concisely combine the specific learning value from duplicate concepts. Do not omit concepts merely because a source is shorter.\n\nCONCEPT LISTS:\n""" + json.dumps([[concept.model_dump() for concept in concepts] for concepts in concept_lists])
    raw = await ask_llm(prompt)
    try:
        merged = [Concept.model_validate(item) for item in raw]
        if not merged or len({concept.id for concept in merged}) != len(merged) or any(not concept.sources for concept in merged):
            raise ValueError("Merged concepts must have unique IDs and sources")
        return merged
    except Exception as exc:
        raise HTTPException(502, "The AI response did not contain valid merged concepts. Please try again.") from exc


async def edges_from_concepts(concepts: list[Concept]) -> list[Edge]:
    prompt = """Given this list of concepts, determine prerequisite relationships. Return ONLY valid JSON: a list of objects {from, to, reason}. 'from' must be understood before 'to'; all IDs must be from the supplied list; reason is one clear sentence.

The result MUST form one connected, top-to-bottom learning tree/DAG with exactly ONE root concept: choose the most fundamental real concept from the supplied list, and ensure every other concept has a prerequisite path from that root. When concepts seem independent, connect them through the most accurate shared foundational concept rather than leaving a second root. Do not create cycles, duplicate edges, or an edge from a concept to itself.\n\nCONCEPTS:\n""" + json.dumps([item.model_dump() for item in concepts])
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


def topological_order(nodes: list[Concept], edges: list[Edge]) -> list[str]:
    ids = [node.id for node in nodes]
    children = {concept_id: [] for concept_id in ids}
    incoming = {concept_id: 0 for concept_id in ids}
    for edge in edges:
        if edge.from_ in children and edge.to in incoming:
            children[edge.from_].append(edge.to)
            incoming[edge.to] += 1
    queue = [concept_id for concept_id in ids if incoming[concept_id] == 0]
    ordered: list[str] = []
    while queue:
        current = queue.pop(0)
        ordered.append(current)
        for child in children[current]:
            incoming[child] -= 1
            if incoming[child] == 0:
                queue.append(child)
    # Keep an API response useful even if a malformed graph somehow contains a cycle.
    return ordered + [concept_id for concept_id in ids if concept_id not in ordered]


def quiz_concepts(nodes: list[Concept], edges: list[Edge]) -> list[Concept]:
    if len(nodes) <= 10:
        return nodes
    by_id = {node.id: node for node in nodes}
    ordered = topological_order(nodes, edges)
    children = {node.id: [] for node in nodes}
    incoming = {node.id: 0 for node in nodes}
    depth = {node.id: 0 for node in nodes}
    for edge in edges:
        if edge.from_ in children and edge.to in incoming:
            children[edge.from_].append(edge.to)
            incoming[edge.to] += 1
    for concept_id in ordered:
        for child in children[concept_id]:
            depth[child] = max(depth[child], depth[concept_id] + 1)

    # A diagnostic should test foundations first, but also sample whether the
    # learner can apply them. This avoids the old root/leaf-only blind spot.
    foundations = sorted(ordered, key=lambda concept_id: (depth[concept_id], ordered.index(concept_id)))
    branch_points = sorted(ordered, key=lambda concept_id: (-len(children[concept_id]), depth[concept_id]))
    leaves = [concept_id for concept_id in ordered if not children[concept_id]]
    chosen: list[Concept] = []
    for concept_id in foundations[:4] + branch_points[:4] + leaves[:2] + ordered:
        concept = by_id[concept_id]
        if concept.id not in {item.id for item in chosen}:
            chosen.append(concept)
        if len(chosen) == 10:
            break
    return chosen


async def question_for_concept(concept: Concept) -> QuizQuestion:
    prompt = f'''Generate ONE short multiple-choice question that tests whether a student understands this concept.
Concept: {concept.name}
Description: {concept.short_description}
Return ONLY valid JSON with exactly {{concept_id, question, options, correct_index, explanation}}. concept_id must be "{concept.id}". options must be exactly 4 concise strings. correct_index must be a zero-based integer from 0 to 3. explanation must briefly explain the correct answer in one sentence. Include exactly one correct option.'''
    schema = {
        "type": "OBJECT",
        "properties": {
            "concept_id": {"type": "STRING"},
            "question": {"type": "STRING"},
            "options": {"type": "ARRAY", "items": {"type": "STRING"}, "minItems": 4, "maxItems": 4},
            "correct_index": {"type": "INTEGER", "minimum": 0, "maximum": 3},
            "explanation": {"type": "STRING"},
        },
        "required": ["concept_id", "question", "options", "correct_index", "explanation"],
    }
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            raw = await ask_llm(prompt + ("\nUse the required field names exactly." if attempt else ""), schema)
            question = QuizQuestion.model_validate(raw)
            if question.concept_id != concept.id or len(question.options) != 4 or question.correct_index not in range(4):
                raise ValueError("Invalid quiz question")
            return question
        except (ValueError, HTTPException) as exc:
            last_error = exc
    raise HTTPException(502, "The AI could not produce a valid quiz question. Please try again.") from last_error


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/extract-concepts", response_model=list[Concept])
async def extract_concepts(text: Annotated[str | None, Form()] = None, file: Annotated[UploadFile | None, File()] = None, source: Annotated[str | None, Form()] = None):
    concepts = await concepts_from_source(await get_source_text(text, file))
    source_name = source or (file.filename if file else "Pasted text") or "Pasted text"
    return [concept.model_copy(update={"sources": [source_name]}) for concept in concepts]


@app.post("/merge-concepts", response_model=list[Concept])
async def merge_concepts(request: MergeConceptsRequest):
    if not request.concept_lists or not any(request.concept_lists):
        raise HTTPException(422, "Add at least one source with extracted concepts before merging.")
    return await merge_concept_lists(request.concept_lists)


@app.post("/extract-edges", response_model=list[Edge])
async def extract_edges(request: EdgeRequest):
    return await edges_from_concepts(request.concepts)


@app.post("/build-graph")
async def build_graph(text: Annotated[str | None, Form()] = None, file: Annotated[UploadFile | None, File()] = None):
    concepts = await concepts_from_source(await get_source_text(text, file))
    edges = await edges_from_concepts(concepts)
    return {"nodes": [item.model_dump() for item in concepts], "edges": [item.model_dump(by_alias=True) for item in edges]}


@app.post("/generate-quiz", response_model=list[QuizResponseQuestion])
async def generate_quiz(request: GraphRequest):
    global latest_quiz, latest_quiz_concepts
    selected = quiz_concepts(request.nodes, request.edges)
    questions = [await question_for_concept(concept) for concept in selected]
    latest_quiz = {question.concept_id: question for question in questions}
    latest_quiz_concepts = {concept.id for concept in request.nodes}
    return [QuizResponseQuestion(concept_id=item.concept_id, question=item.question, options=item.options, correct_index=item.correct_index, explanation=item.explanation) for item in questions]


@app.post("/evaluate-quiz")
async def evaluate_quiz(request: QuizAnswerRequest):
    if not latest_quiz:
        raise HTTPException(409, "No active quiz was found. Generate a quiz and submit it before evaluating.")
    status = {concept_id: "unknown" for concept_id in latest_quiz_concepts}
    for answer in request.answers:
        question = latest_quiz.get(answer.concept_id)
        if question:
            status[answer.concept_id] = "known" if answer.selected_index == question.correct_index else "gap"
    return status


@app.post("/concept-explanation", response_model=ConceptExplanationResponse)
async def concept_explanation(request: ConceptExplanationRequest):
    concept_name = request.name.strip() or request.concept_id.replace("-", " ").title()
    description = request.description.strip() or "This concept is part of the learning graph."
    prompt = f'''Explain this concept simply for a student who is struggling with it: {concept_name} — {description}. Keep it short (3-5 sentences), clear, and encouraging. Then suggest ONE concrete way to practice or study it further.
Return ONLY valid JSON with exactly {{concept_id, explanation, study_tip}}. concept_id must be "{request.concept_id}". explanation must be 3-5 sentences. study_tip must be a single clear suggestion.
'''
    schema = {
        "type": "OBJECT",
        "properties": {
            "concept_id": {"type": "STRING"},
            "explanation": {"type": "STRING"},
            "study_tip": {"type": "STRING"},
        },
        "required": ["concept_id", "explanation", "study_tip"],
    }
    try:
        raw = await ask_llm(prompt, schema)
        response = ConceptExplanationResponse.model_validate(raw)
        return response
    except Exception as exc:
        raise HTTPException(502, "The AI could not produce a useful explanation. Please try again.") from exc


@app.post("/retest-concept", response_model=RetestConceptResponse)
async def retest_concept(request: RetestConceptRequest):
    concept_name = request.name.strip() or request.concept_id.replace("-", " ").title()
    description = request.description.strip() or "This concept is part of the learning graph."
    prompt = f'''Generate exactly 3 different multiple-choice questions for this concept. Each question should test deeper understanding, not just recall, and should vary across real-world application, cause/effect, comparison, or common misconception angles. Concept: {concept_name}. Description: {description}. 
Return ONLY valid JSON as an array of exactly 3 objects with exactly {{concept_id, question, options, correct_index}}. concept_id must be "{request.concept_id}" for every item. Each options array must contain exactly 4 concise strings. correct_index must be a zero-based integer from 0 to 3 for every item.
'''
    schema = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "concept_id": {"type": "STRING"},
                "question": {"type": "STRING"},
                "options": {"type": "ARRAY", "items": {"type": "STRING"}, "minItems": 4, "maxItems": 4},
                "correct_index": {"type": "INTEGER", "minimum": 0, "maximum": 3},
            },
            "required": ["concept_id", "question", "options", "correct_index"],
        },
        "minItems": 3,
        "maxItems": 3,
    }
    try:
        raw = await ask_llm(prompt, schema)
        if not isinstance(raw, list):
            raise ValueError("Retest response must be a list of questions.")
        questions = [RetestQuestionResponse.model_validate(item) for item in raw]
        if len(questions) != 3 or any(len(question.options) != 4 or question.correct_index not in range(4) for question in questions):
            raise ValueError("Retest questions must include exactly three valid items.")
        return RetestConceptResponse(concept_id=request.concept_id, questions=questions)
    except Exception as exc:
        raise HTTPException(502, "The AI could not produce a valid retest set. Please try again.") from exc


@app.post("/evaluate-retest")
async def evaluate_retest(request: RetestEvaluationRequest):
    if request.selected_index not in range(4):
        raise HTTPException(422, "The selected answer index is invalid.")
    if request.correct_index not in range(4):
        raise HTTPException(422, "The correct answer index is invalid.")
    status = "known" if request.selected_index == request.correct_index else "gap"
    return {"status": status}


@app.post("/generate-path", response_model=list[PathStep])
async def generate_path(request: PathRequest):
    order = topological_order(request.nodes, request.edges)
    ids = {node.id for node in request.nodes}
    normalized_status = {concept_id: request.status.get(concept_id, "unknown") for concept_id in ids}
    prompt = """Given this concept dependency graph and this student's status per concept, generate an ordered personalized study path. Skip or briefly mention 'known' concepts, prioritize 'gap' concepts early when prerequisites allow, and order 'unknown' concepts by their topological position. Return ONLY valid JSON as an ordered list of objects {concept_id, priority, reason}. priority must be exactly one of 'skip', 'review', 'gap', or 'new'. Use every supplied concept exactly once. The order must respect the supplied topological order: a concept cannot appear before any prerequisite. reason is one clear sentence.\n\nTOPOLOGICAL ORDER:\n""" + json.dumps(order) + "\n\nCONCEPTS:\n" + json.dumps([node.model_dump() for node in request.nodes]) + "\n\nEDGES:\n" + json.dumps([edge.model_dump(by_alias=True) for edge in request.edges]) + "\n\nSTATUS:\n" + json.dumps(normalized_status)
    raw = await ask_llm(prompt)
    try:
        candidate = [PathStep.model_validate(item) for item in raw]
    except Exception as exc:
        raise HTTPException(502, "The AI response did not contain a valid learning path. Please try again.") from exc
    valid_priorities = {"skip", "review", "gap", "new"}
    by_id = {item.concept_id: item for item in candidate if item.concept_id in ids and item.priority in valid_priorities}
    proposed_order = [item.concept_id for item in candidate if item.concept_id in by_id]
    is_complete = set(proposed_order) == ids and len(proposed_order) == len(ids)
    positions = {concept_id: index for index, concept_id in enumerate(proposed_order)}
    respects_edges = is_complete and all(positions[edge.from_] < positions[edge.to] for edge in request.edges if edge.from_ in positions and edge.to in positions)
    if respects_edges:
        return [by_id[concept_id] for concept_id in proposed_order]
    fallback_priority = {"known": "skip", "gap": "gap", "unknown": "new"}
    return [PathStep(concept_id=concept_id, priority=by_id.get(concept_id, PathStep(concept_id=concept_id, priority=fallback_priority.get(normalized_status[concept_id], "new"), reason="Follow this step in prerequisite order.")).priority, reason=by_id.get(concept_id, PathStep(concept_id=concept_id, priority="new", reason="Follow this step in prerequisite order.")).reason) for concept_id in order]

from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import uuid
import logging
import base64
import tempfile
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
GEMINI_MODEL = "gemini-2.5-pro"

# Create the main app without a prefix
app = FastAPI(title="AI Sathi - English Nepali Translator")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# ---------- Request / Response models ----------
class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    source_lang: str = Field(..., description="'en' or 'ne'")
    target_lang: str = Field(..., description="'en' or 'ne'")


class TranslateResponse(BaseModel):
    translated_text: str
    source_lang: str
    target_lang: str


class ImageTranslateRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded image (no data: prefix)")
    mime_type: str = Field(default="image/jpeg")
    target_lang: str = Field(..., description="'en' or 'ne'")


class ImageTranslateResponse(BaseModel):
    extracted_text: str
    translated_text: str
    detected_lang: Optional[str] = None
    target_lang: str
    summary: str = ""
    spoken_message: str = ""
    action_items: list[str] = []


# ---------- Helpers ----------
LANG_NAMES = {"en": "English", "ne": "Nepali"}


def _validate_lang(code: str) -> str:
    code = (code or "").lower().strip()
    if code not in LANG_NAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {code}")
    return code


def _build_chat(system_message: str) -> LlmChat:
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=str(uuid.uuid4()),
        system_message=system_message,
    ).with_model("gemini", GEMINI_MODEL)
    return chat


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "AI Sathi backend running", "model": GEMINI_MODEL}


@api_router.post("/translate", response_model=TranslateResponse)
async def translate_text(req: TranslateRequest):
    src = _validate_lang(req.source_lang)
    tgt = _validate_lang(req.target_lang)

    if src == tgt:
        return TranslateResponse(translated_text=req.text, source_lang=src, target_lang=tgt)

    system = (
        f"You are an expert translator between English and Nepali (नेपाली). "
        f"Translate the user's text from {LANG_NAMES[src]} to {LANG_NAMES[tgt]}. "
        f"Rules:\n"
        f"1. Output ONLY the translated text. No explanations, no quotes, no labels.\n"
        f"2. Preserve tone, punctuation and line breaks.\n"
        f"3. For Nepali output use Devanagari script. For English use Latin script.\n"
        f"4. Translate idioms naturally rather than word-for-word."
    )

    try:
        chat = _build_chat(system)
        result = await chat.send_message(UserMessage(text=req.text))
        translated = (result or "").strip()
        if not translated:
            raise HTTPException(status_code=502, detail="Empty translation from model")
        return TranslateResponse(translated_text=translated, source_lang=src, target_lang=tgt)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("translate failed")
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")


@api_router.post("/translate-image", response_model=ImageTranslateResponse)
async def translate_image(req: ImageTranslateRequest):
    tgt = _validate_lang(req.target_lang)

    mime = (req.mime_type or "image/jpeg").lower()
    if mime not in {"image/jpeg", "image/jpg", "image/png", "image/webp"}:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {mime}")
    if mime == "image/jpg":
        mime = "image/jpeg"

    # Decode base64 to a temp file (Gemini path supports FileContentWithMimeType)
    b64 = req.image_base64.strip()
    if b64.startswith("data:"):
        # strip data URI prefix if present
        try:
            b64 = b64.split(",", 1)[1]
        except Exception:
            pass

    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image")

    if len(raw) < 100:
        raise HTTPException(status_code=400, detail="Image is too small or empty")

    suffix = ".jpg" if mime == "image/jpeg" else (".png" if mime == "image/png" else ".webp")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()

        # Step 1: OCR + detect language
        extract_system = (
            "You are an OCR engine. Look at the image carefully and extract ALL readable "
            "text exactly as it appears. The text may be in English (Latin script) or "
            "Nepali (Devanagari script). Return STRICT JSON of the form:\n"
            '{"text": "...extracted text...", "language": "en" | "ne" | "unknown"}\n'
            "Rules: Output ONLY the JSON object, no markdown, no commentary. Preserve "
            "line breaks inside the text using \\n. If no readable text is present, "
            'return {"text": "", "language": "unknown"}.'
        )
        chat = _build_chat(extract_system)
        file_content = FileContentWithMimeType(file_path=tmp.name, mime_type=mime)
        ocr_resp = await chat.send_message(
            UserMessage(text="Extract text and detect its language.", file_contents=[file_content])
        )

        # Parse JSON robustly
        import json, re
        ocr_text = ""
        detected = "unknown"
        if ocr_resp:
            cleaned = ocr_resp.strip()
            # strip ```json fences if model added them
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.MULTILINE).strip()
            try:
                parsed = json.loads(cleaned)
                ocr_text = (parsed.get("text") or "").strip()
                detected = (parsed.get("language") or "unknown").lower()
            except Exception:
                # fallback: use whole response as text
                ocr_text = cleaned
                detected = "unknown"

        if not ocr_text:
            return ImageTranslateResponse(
                extracted_text="",
                translated_text="",
                detected_lang=detected if detected in {"en", "ne"} else None,
                target_lang=tgt,
                summary="",
                spoken_message=("कुनै पाठ भेटिएन। कृपया स्पष्ट तस्बिर खिच्नुहोस्।"
                                if tgt == "ne"
                                else "No readable text found. Please try a clearer photo."),
                action_items=[],
            )

        # Determine source language: trust model; otherwise infer by script presence
        if detected not in {"en", "ne"}:
            has_devanagari = any("\u0900" <= ch <= "\u097F" for ch in ocr_text)
            detected = "ne" if has_devanagari else "en"

        # Step 2: translate to target if different
        if detected == tgt:
            translated = ocr_text
        else:
            translate_system = (
                f"You are an expert translator between English and Nepali. "
                f"Translate from {LANG_NAMES[detected]} to {LANG_NAMES[tgt]}. "
                f"Output ONLY the translated text. No explanations or quotes. "
                f"Preserve line breaks."
            )
            t_chat = _build_chat(translate_system)
            t_resp = await t_chat.send_message(UserMessage(text=ocr_text))
            translated = (t_resp or "").strip()

        # Step 3: Summarize + extract action items as a single voice-friendly message
        target_label = LANG_NAMES[tgt]
        summary_system = (
            f"You are an assistant helping a {target_label} speaker who may not "
            f"read {target_label} well and needs information by voice. The user "
            f"photographed a document (could be a bill, letter, receipt, sign, "
            f"prescription, notice, etc.). Read the document carefully and "
            f"produce a short, plain-spoken explanation in {target_label} that:\n"
            f"  - Identifies what kind of document it is (bill, notice, receipt, etc.)\n"
            f"  - States the most important facts: who it is from, amounts, dates, deadlines, account numbers if relevant.\n"
            f"  - Lists any actions the person must take (pay $X by Y date, call number, reply by date, etc.).\n"
            f"  - Sounds natural when read aloud (no bullet points, no markdown, no labels).\n\n"
            f"Return STRICT JSON of the form:\n"
            '{"summary": "<one short sentence in ' + target_label + ' describing the document>", '
            '"spoken_message": "<2-4 short sentences in ' + target_label + ' suitable for text-to-speech>", '
            '"action_items": ["<short action 1 in ' + target_label + '>", "..."]}\n\n'
            f"If the document has no actions required, return an empty action_items list. "
            f"Output ONLY the JSON object, no markdown, no commentary."
        )

        summary_obj = {"summary": "", "spoken_message": translated, "action_items": []}
        try:
            s_chat = _build_chat(summary_system)
            s_input = (
                f"Original document text ({LANG_NAMES[detected]}):\n{ocr_text}\n\n"
                f"Translation ({target_label}):\n{translated}"
            )
            s_resp = await s_chat.send_message(UserMessage(text=s_input))
            if s_resp:
                cleaned = s_resp.strip()
                cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.MULTILINE).strip()
                parsed = json.loads(cleaned)
                summary_obj["summary"] = (parsed.get("summary") or "").strip()
                spoken = (parsed.get("spoken_message") or "").strip()
                if spoken:
                    summary_obj["spoken_message"] = spoken
                items = parsed.get("action_items") or []
                summary_obj["action_items"] = [str(i).strip() for i in items if str(i).strip()]
        except Exception:
            logging.exception("summary generation failed; using translation as fallback")

        return ImageTranslateResponse(
            extracted_text=ocr_text,
            translated_text=translated,
            detected_lang=detected,
            target_lang=tgt,
            summary=summary_obj["summary"],
            spoken_message=summary_obj["spoken_message"],
            action_items=summary_obj["action_items"],
        )
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("translate-image failed")
        raise HTTPException(status_code=500, detail=f"Image translation failed: {str(e)}")
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

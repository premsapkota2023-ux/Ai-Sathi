from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import uuid
import logging
import base64
import tempfile
import json
import re
import asyncio
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType
from emergentintegrations.llm.openai import OpenAISpeechToText


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
# Use gemini-2.5-flash for speed (translation + vision OCR).
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

# Create the main app without a prefix
app = FastAPI(title="AI Sathi - English Nepali Translator")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# ---------- Request / Response models ----------
class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    source_lang: str = Field(..., description="'en' or 'ne'")
    target_lang: str = Field(..., description="'en' or 'ne'")


class CalendarEvent(BaseModel):
    title: str
    start_iso: str  # ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
    all_day: bool = False
    type: str = "other"  # bill | appointment | deadline | other
    description: str = ""


class TranslateResponse(BaseModel):
    translated_text: str
    source_lang: str
    target_lang: str
    calendar_events: list[CalendarEvent] = []


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
    calendar_events: list[CalendarEvent] = []


class TranscribeRequest(BaseModel):
    audio_base64: str = Field(..., description="Base64 encoded audio (no data: prefix)")
    mime_type: str = Field(default="audio/m4a")
    language: Optional[str] = Field(default=None, description="ISO-639-1 hint, e.g. 'ne' or 'en'. Optional.")


class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str] = None


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


async def _extract_events_from_text(text: str) -> list[CalendarEvent]:
    """Run a focused Gemini call to extract calendar events from arbitrary text.
    Returns [] on any failure or if no absolute dates are mentioned."""
    if not text or not text.strip():
        return []
    # Quick regex pre-check: skip the LLM call entirely if there's no date-like signal
    date_signals = re.compile(
        r"(\d{1,2}[/\-:]\d{1,2}|"  # 12/15 or 12-15 or 10:30
        r"\b(?:january|february|march|april|may|june|july|august|"
        r"september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|"
        r"जनवरी|फेब्रुअरी|मार्च|अप्रिल|मे|जुन|जुलाई|अगस्ट|"
        r"सेप्टेम्बर|अक्टोबर|नोभेम्बर|डिसेम्बर|"
        r"\bबजे\b|\b\d{4}\b|"
        r"\b(?:today|tomorrow|tonight|tmrw|yesterday|next|this|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
        r"mon|tue|wed|thu|fri|sat|sun|"
        r"morning|afternoon|evening|night|noon|midnight|"
        r"am|pm|a\.m\.|p\.m\.|o'?clock|"
        r"appointment|meeting|due|deadline|bill|payment|reminder|schedule|"
        r"भोलि|आज|अहिले|पर्सि|भेट|बिल|मिति|तारिख|तिर्नु|बिहान|दिउँसो|बेलुका|राति)\b)",
        re.IGNORECASE,
    )
    if not date_signals.search(text):
        return []

    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%A, %B %d, %Y")
    system = (
        f"You extract calendar reminders from short pieces of text. "
        f"Today's date is {today}. "
        "Read the user's text and find any events the person should be reminded "
        "about (bill due dates, doctor appointments, meetings, deadlines, etc.).\n\n"
        "Output STRICT JSON of the form:\n"
        '{"events": [{'
        '"title": "<short event title in ENGLISH>", '
        '"start_iso": "<YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS — absolute date/time>", '
        '"all_day": <true|false>, '
        '"type": "<bill|appointment|deadline|other>", '
        '"description": "<1-2 sentence description in ENGLISH>"'
        '}]}\n\n'
        "Rules:\n"
        "- Accept BOTH absolute dates (e.g. 'December 15, 2026', '12/15/2026') AND "
        "relative dates (e.g. 'tomorrow', 'tonight', 'next Monday', 'in 3 days', "
        "'this Friday', 'भोलि', 'पर्सि').\n"
        f"- For relative dates, resolve them to absolute calendar dates relative to TODAY "
        f"({today}). For example, if today is {today}, 'tomorrow' = the next calendar day.\n"
        "- For events without a specific time, set all_day=true.\n"
        "- For events with a time but no date (e.g. 'at 5pm'), assume TODAY if the time is "
        "still in the future today, otherwise tomorrow.\n"
        "- If no event-worthy mention is found at all, return {\"events\": []}.\n"
        "- title and description must be in English (Latin script) regardless of input language.\n"
        "- Output ONLY the JSON object, no markdown fences, no commentary."
    )
    try:
        chat = _build_chat(system)
        resp = await chat.send_message(UserMessage(text=text))
        if not resp:
            return []
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", resp.strip(), flags=re.MULTILINE).strip()
        parsed = json.loads(cleaned)
        events_raw = parsed.get("events") or []
        out: list[CalendarEvent] = []
        for ev in events_raw:
            if not isinstance(ev, dict):
                continue
            title = str(ev.get("title", "")).strip()
            start_iso = str(ev.get("start_iso", "")).strip()
            if not title or not start_iso:
                continue
            if not re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$", start_iso):
                continue
            out.append(CalendarEvent(
                title=title,
                start_iso=start_iso,
                all_day=bool(ev.get("all_day", "T" not in start_iso)),
                type=str(ev.get("type", "other")).strip().lower() or "other",
                description=str(ev.get("description", "")).strip(),
            ))
        return out
    except Exception:
        logging.exception("event extraction failed")
        return []


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "AI Sathi backend running", "model": GEMINI_MODEL}


# Temporary endpoint to download the generated app icon files.
# Allows the user to grab the icons directly from the preview URL without
# needing GitHub. Whitelisted to icon files only.
_ICON_DIR = Path("/app/frontend/assets/images")
_ALLOWED_ICONS = {
    "icon.png",
    "adaptive-icon.png",
    "splash-icon.png",
    "splash-image.png",
    "app-image.png",
    "favicon.png",
    "icon-master-2048.png",
    "ai_sathi_icons.zip",
}


@api_router.get("/icons/{filename}")
async def download_icon(filename: str):
    if filename not in _ALLOWED_ICONS:
        raise HTTPException(status_code=404, detail="Not found")
    if filename == "ai_sathi_icons.zip":
        path = Path("/tmp/ai_sathi_icons.zip")
    else:
        path = _ICON_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    media = "image/png" if filename.endswith(".png") else "application/zip"
    return FileResponse(
        str(path),
        media_type=media,
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api_router.post("/translate", response_model=TranslateResponse)
async def translate_text(req: TranslateRequest):
    src = _validate_lang(req.source_lang)
    tgt = _validate_lang(req.target_lang)

    if src == tgt:
        return TranslateResponse(translated_text=req.text, source_lang=src, target_lang=tgt)

    # Plain-text translation prompt (NO JSON — far more reliable on flash model)
    system = (
        f"You are an expert translator between English and Nepali (नेपाली) "
        f"who specializes in everyday spoken language. "
        f"Translate the user's text from {LANG_NAMES[src]} to {LANG_NAMES[tgt]}. "
        f"Rules:\n"
        f"1. Output ONLY the translated text. No explanations, no quotes, no labels, no JSON.\n"
        f"2. Preserve tone, punctuation and line breaks.\n"
        f"3. For Nepali output use Devanagari script. For English use Latin script.\n"
        f"4. The input may contain colloquial speech, Nepali SLANG and informal expressions "
        f"(e.g. 'के गर्ने', 'हो नि', 'दामी', 'झुर'). Translate them naturally to the equivalent "
        f"everyday phrasing.\n"
        f"5. Handle CODE-SWITCHED input where Nepali speakers mix English words. Treat the "
        f"whole sentence as one and produce a clean translation.\n"
        f"6. Nepali speakers often pronounce V as B in English words. Words like 'bideo', "
        f"'bery', 'boice', 'bisit', 'ebening' should be interpreted as their proper V "
        f"equivalents (video, very, voice, visit, evening) and translated accordingly.\n"
        f"7. For idioms, choose a culturally appropriate equivalent rather than literal words."
    )

    async def do_translate() -> str:
        chat = _build_chat(system)
        result = await chat.send_message(UserMessage(text=req.text))
        return (result or "").strip()

    try:
        # Run translation and event extraction IN PARALLEL.
        # If event extraction fails for any reason, we still return translation.
        translation, events = await asyncio.gather(
            do_translate(),
            _extract_events_from_text(req.text),
            return_exceptions=False,
        )

        if not translation:
            raise HTTPException(status_code=502, detail="Empty translation from model")

        return TranslateResponse(
            translated_text=translation,
            source_lang=src,
            target_lang=tgt,
            calendar_events=events or [],
        )
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("translate failed")
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")


@api_router.post("/translate-image", response_model=ImageTranslateResponse)
async def translate_image(req: ImageTranslateRequest):
    tgt = _validate_lang(req.target_lang)

    mime = (req.mime_type or "image/jpeg").lower()
    allowed_mimes = {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "application/pdf",
    }
    if mime not in allowed_mimes:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {mime}")
    if mime == "image/jpg":
        mime = "image/jpeg"
    is_pdf = mime == "application/pdf"

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
        raise HTTPException(status_code=400, detail="File is too small or empty")
    # Cap at 20 MB (Gemini's PDF limit; images are usually well under)
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 20 MB limit")

    if is_pdf:
        suffix = ".pdf"
    elif mime == "image/png":
        suffix = ".png"
    elif mime == "image/webp":
        suffix = ".webp"
    else:
        suffix = ".jpg"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()

        # Step 1: OCR + detect language
        if is_pdf:
            extract_system = (
                "You are an OCR engine reading a multi-page PDF document. "
                "Extract ALL readable text from EVERY page, in order, separated by "
                "blank lines between pages. The text may be in English (Latin script) "
                "or Nepali (Devanagari script). Return STRICT JSON of the form:\n"
                '{"text": "<all extracted text from all pages, with \\n\\n between pages>", '
                '"language": "en" | "ne" | "unknown"}\n'
                "Rules: Output ONLY the JSON object, no markdown, no commentary. "
                "Preserve line breaks inside the text using \\n. "
                'If no readable text is present, return {"text": "", "language": "unknown"}.'
            )
            extract_user_text = "Extract all text from every page of this PDF and detect its primary language."
        else:
            extract_system = (
                "You are an OCR engine. Look at the image carefully and extract ALL readable "
                "text exactly as it appears. The text may be in English (Latin script) or "
                "Nepali (Devanagari script). Return STRICT JSON of the form:\n"
                '{"text": "...extracted text...", "language": "en" | "ne" | "unknown"}\n'
                "Rules: Output ONLY the JSON object, no markdown, no commentary. Preserve "
                "line breaks inside the text using \\n. If no readable text is present, "
                'return {"text": "", "language": "unknown"}.'
            )
            extract_user_text = "Extract text and detect its language."
        chat = _build_chat(extract_system)
        file_content = FileContentWithMimeType(file_path=tmp.name, mime_type=mime)
        ocr_resp = await chat.send_message(
            UserMessage(text=extract_user_text, file_contents=[file_content])
        )

        # Parse JSON robustly
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
            f"prescription, notice, appointment card, etc.). Read the document "
            f"carefully and produce a short, plain-spoken explanation in {target_label} that:\n"
            f"  - Identifies what kind of document it is (bill, notice, receipt, etc.)\n"
            f"  - States the most important facts: who it is from, amounts, dates, deadlines, account numbers if relevant.\n"
            f"  - Lists any actions the person must take (pay $X by Y date, call number, reply by date, etc.).\n"
            f"  - Sounds natural when read aloud (no bullet points, no markdown, no labels).\n\n"
            f"Also extract any CALENDAR EVENTS that the person should be reminded about — bill "
            f"due dates, doctor appointments, meetings, deadlines, etc. Only include events with "
            f"an absolute calendar date (e.g. 'December 15, 2026' or '12/15/2026'). DO NOT include "
            f"vague dates like 'tomorrow' or 'next week'. For bills with no specific time, leave "
            f"all_day=true. For appointments with a known time, include the time.\n\n"
            f"Return STRICT JSON of the form:\n"
            '{"summary": "<one short sentence in ' + target_label + ' describing the document>", '
            '"spoken_message": "<2-4 short sentences in ' + target_label + ' suitable for text-to-speech>", '
            '"action_items": ["<short action 1 in ' + target_label + '>", "..."], '
            '"calendar_events": [{'
            '"title": "<short event title in ENGLISH (calendars handle Latin script better)>", '
            '"start_iso": "<YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS — the absolute date/time>", '
            '"all_day": <true | false>, '
            '"type": "<bill | appointment | deadline | other>", '
            '"description": "<1-2 sentence description in ENGLISH with key amounts/contact info>"'
            '}]}\n\n'
            f"If the document has no actions required, return action_items=[]. "
            f"If the document has no calendar-worthy dates, return calendar_events=[]. "
            f"Output ONLY the JSON object, no markdown, no commentary."
        )

        summary_obj = {
            "summary": "",
            "spoken_message": translated,
            "action_items": [],
            "calendar_events": [],
        }
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
                # Validate calendar events
                events_raw = parsed.get("calendar_events") or []
                valid_events = []
                for ev in events_raw:
                    if not isinstance(ev, dict):
                        continue
                    title = str(ev.get("title", "")).strip()
                    start_iso = str(ev.get("start_iso", "")).strip()
                    if not title or not start_iso:
                        continue
                    # basic ISO format validation
                    if not re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$", start_iso):
                        continue
                    valid_events.append(CalendarEvent(
                        title=title,
                        start_iso=start_iso,
                        all_day=bool(ev.get("all_day", "T" not in start_iso)),
                        type=str(ev.get("type", "other")).strip().lower() or "other",
                        description=str(ev.get("description", "")).strip(),
                    ))
                summary_obj["calendar_events"] = valid_events
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
            calendar_events=summary_obj["calendar_events"],
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


# ---------- Speech-to-Text (Whisper) ----------
@api_router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(req: TranscribeRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not configured")

    mime = (req.mime_type or "audio/m4a").lower()
    # OpenAI Whisper supports: mp3, mp4, mpeg, mpga, m4a, wav, webm
    ext_map = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".mp4",
        "audio/m4a": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/webm": ".webm",
        "audio/ogg": ".webm",
    }
    suffix = ext_map.get(mime, ".m4a")

    b64 = (req.audio_base64 or "").strip()
    if b64.startswith("data:"):
        try:
            b64 = b64.split(",", 1)[1]
        except Exception:
            pass
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 audio")

    if len(raw) < 500:
        raise HTTPException(status_code=400, detail="Audio is too short or empty")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Audio exceeds 25 MB limit")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()

        stt = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
        # Whisper context prompt — guides the model on register, common words, and slang.
        # Per Whisper docs, the prompt should be in the SAME script as expected output.
        nepali_prompt = (
            "यो एउटा नेपाली कुराकानी हो। बोल्ने मानिसले छिटो बोल्न सक्छ र "
            "बोलचालका शब्दहरू, स्ल्याङ, र अंग्रेजी शब्दहरू मिसाएर बोल्न सक्छ। "
            "नेपाली बोल्नेहरूले अंग्रेजी शब्दहरूमा V र B लाई कहिलेकाहीँ मिसाउँछन्, "
            "त्यसैले 'video, voice, very, value, available, service, advice, vehicle, "
            "visit, evening, have, give, love, save, leave, drive, advise, develop, "
            "movie, vote' जस्ता V भएका अंग्रेजी शब्दहरू पनि सुनिन सक्छन्। "
            "सामान्य शब्दहरू: नमस्ते, धन्यवाद, कस्तो छ, ठीक छ, हजुर, भाइ, दिदि, "
            "बाबा, आमा, घर, खाना, पानी, बाटो, बजार, अस्पताल, बैङ्क, कार्यालय, "
            "कल, मेसेज, समय, आज, भोलि, हिजो, हो नि, के गर्ने, दामी, मस्त, "
            "जाबो, टन्न, साँच्चै, साथी।"
        )
        english_prompt = (
            "This is everyday spoken English, possibly with a Nepali accent where "
            "the speaker may pronounce V as B (e.g. saying 'bideo' for video, "
            "'bery' for very, 'haf' for have). Common words: video, voice, very, "
            "value, available, service, advice, vehicle, visit, evening, have, "
            "give, love, save, leave, drive, advise, develop, movie, vote, "
            "hello, please, thank you, sorry, yes, no, today, tomorrow, work, "
            "family, food, money, bill, payment, due date."
        )
        kwargs = {
            "model": "whisper-1",
            "response_format": "verbose_json",
            "temperature": 0.0,
        }
        lang = (req.language or "").lower()
        if lang in {"en", "ne"}:
            kwargs["language"] = lang
            kwargs["prompt"] = nepali_prompt if lang == "ne" else english_prompt

        with open(tmp.name, "rb") as audio_file:
            response = await stt.transcribe(file=audio_file, **kwargs)

        text = (getattr(response, "text", None) or "").strip()
        detected_lang = getattr(response, "language", None)
        # Whisper returns language as ISO code (e.g., 'english', 'nepali' or 'en'/'ne' depending on version)
        if detected_lang:
            dl = str(detected_lang).lower()
            if dl.startswith("ne") or "nepali" in dl:
                detected_lang = "ne"
            elif dl.startswith("en") or "english" in dl:
                detected_lang = "en"
            else:
                detected_lang = None

        return TranscribeResponse(text=text, language=detected_lang)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("transcribe failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
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

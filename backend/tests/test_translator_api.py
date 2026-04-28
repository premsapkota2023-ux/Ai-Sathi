"""Backend tests for AI Sathi translator APIs."""
import base64
import io
import pytest

# ------------------------------------------------------------
# /api/translate
# ------------------------------------------------------------
class TestTranslateText:
    def test_root(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200
        assert "AI Sathi" in r.json().get("message", "")

    def test_en_to_ne(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/translate",
            json={"text": "Hello, how are you?", "source_lang": "en", "target_lang": "ne"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["source_lang"] == "en" and data["target_lang"] == "ne"
        tr = data["translated_text"]
        assert tr and tr.strip()
        # must contain Devanagari
        assert any("\u0900" <= c <= "\u097F" for c in tr), f"No Devanagari in: {tr}"

    def test_ne_to_en(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/translate",
            json={"text": "मलाई पानी चाहियो", "source_lang": "ne", "target_lang": "en"},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        tr = r.json()["translated_text"]
        assert tr and tr.strip()
        # must contain ASCII letters only (mostly)
        assert any(c.isascii() and c.isalpha() for c in tr)
        assert not any("\u0900" <= c <= "\u097F" for c in tr)

    def test_same_language_returns_unchanged(self, api_client, base_url):
        text = "This should be unchanged."
        r = api_client.post(
            f"{base_url}/api/translate",
            json={"text": text, "source_lang": "en", "target_lang": "en"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["translated_text"] == text

    def test_invalid_lang_code(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/translate",
            json={"text": "hi", "source_lang": "fr", "target_lang": "ne"},
            timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_empty_text_returns_422(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/translate",
            json={"text": "", "source_lang": "en", "target_lang": "ne"},
            timeout=30,
        )
        assert r.status_code == 422, r.text


# ------------------------------------------------------------
# /api/translate-image helpers
# ------------------------------------------------------------
def _make_bill_png_b64() -> str:
    """Create a PNG that mimics a water bill."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (800, 500), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = None
    font_small = None
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        try:
            font = ImageFont.truetype(p, 48)
            font_small = ImageFont.truetype(p, 36)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
        font_small = font
    lines = [
        ("WATER BILL", font),
        ("Amount Due: $50.00", font_small),
        ("Due Date: Dec 15 2026", font_small),
        ("XYZ Water Co.", font_small),
    ]
    y = 30
    for text, f in lines:
        draw.text((40, y), text, fill=(0, 0, 0), font=f)
        y += 90
    # Texture
    for i in range(0, 800, 80):
        draw.line([(i, 0), (i, 500)], fill=(245, 245, 245), width=1)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _make_noise_png_b64() -> str:
    """Pure visual noise but with structure (no text)."""
    from PIL import Image
    import random
    random.seed(42)
    img = Image.new("RGB", (400, 300))
    px = img.load()
    for x in range(400):
        for y in range(300):
            v = random.randint(0, 255)
            px[x, y] = (v, v, v)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _make_appointment_png_b64() -> str:
    """Create a PNG that mimics a doctor appointment letter."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (800, 500), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = font_small = None
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        try:
            font = ImageFont.truetype(p, 44)
            font_small = ImageFont.truetype(p, 34)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
        font_small = font
    lines = [
        ("DOCTOR APPOINTMENT", font),
        ("Dr. Smith", font_small),
        ("Date: January 20, 2026", font_small),
        ("Time: 10:30 AM", font_small),
    ]
    y = 30
    for text, f in lines:
        draw.text((40, y), text, fill=(0, 0, 0), font=f)
        y += 90
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _make_relative_date_png_b64() -> str:
    """Image with only relative date references."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (700, 200), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = None
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        try:
            font = ImageFont.truetype(p, 48)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    draw.text((40, 70), "See you tomorrow!", fill=(0, 0, 0), font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _make_text_png_b64(text: str = "HELLO WORLD") -> str:
    """Create a real PNG image containing the given text, return base64 string."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (600, 200), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    # Try to use a default font, fall back to PIL default
    font = None
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        try:
            font = ImageFont.truetype(p, 72)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    draw.text((40, 60), text, fill=(0, 0, 0), font=font)
    # Add some texture so it's not uniform variance
    for i in range(0, 600, 60):
        draw.line([(i, 0), (i, 200)], fill=(240, 240, 240), width=1)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class TestTranslateImage:
    def test_image_english_to_nepali(self, api_client, base_url):
        b64 = _make_text_png_b64("HELLO WORLD")
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=90,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["target_lang"] == "ne"
        extracted = (data.get("extracted_text") or "").strip()
        assert extracted, f"extracted_text empty: {data}"
        # Detected language should be en
        assert data.get("detected_lang") == "en", f"detected_lang={data.get('detected_lang')}"
        # Translated should contain Devanagari
        tr = (data.get("translated_text") or "").strip()
        assert tr, "translated_text empty"
        assert any("\u0900" <= c <= "\u097F" for c in tr), f"No Devanagari in: {tr}"

    def test_invalid_base64(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": "@@@not-base64@@@", "mime_type": "image/png", "target_lang": "ne"},
            timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_unsupported_mime(self, api_client, base_url):
        b64 = _make_text_png_b64("HI")
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/svg", "target_lang": "ne"},
            timeout=30,
        )
        assert r.status_code == 400, r.text

    # ---------- Iteration 2: summary / spoken_message / action_items ----------
    def test_image_bill_returns_summary_and_actions(self, api_client, base_url):
        b64 = _make_bill_png_b64()
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["target_lang"] == "ne"
        extracted = (data.get("extracted_text") or "").strip()
        assert extracted, f"extracted_text empty: {data}"
        # Expect English keywords present in OCR
        upper = extracted.upper()
        assert "WATER" in upper or "BILL" in upper, f"OCR missed bill keywords: {extracted}"
        # Translated text in Devanagari
        tr = (data.get("translated_text") or "").strip()
        assert tr and any("\u0900" <= c <= "\u097F" for c in tr), f"No Devanagari in: {tr}"
        # Summary in Nepali Devanagari
        summary = (data.get("summary") or "").strip()
        assert summary, f"summary empty: {data}"
        assert any("\u0900" <= c <= "\u097F" for c in summary), f"summary not Nepali: {summary}"
        # Spoken message in Nepali
        spoken = (data.get("spoken_message") or "").strip()
        assert spoken
        assert any("\u0900" <= c <= "\u097F" for c in spoken), f"spoken not Nepali: {spoken}"
        # Action items: list of strings (likely 1-2 about paying $50 by Dec 15)
        items = data.get("action_items")
        assert isinstance(items, list)
        # Print for debugging
        print("BILL summary=", summary)
        print("BILL spoken_message=", spoken)
        print("BILL action_items=", items)

    def test_image_simple_text_summary_optional_actions(self, api_client, base_url):
        b64 = _make_text_png_b64("HELLO WORLD")
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # spoken_message should exist (even if summary is empty)
        spoken = (data.get("spoken_message") or "").strip()
        assert spoken, "spoken_message must be non-empty"
        # In target lang (Devanagari)
        assert any("\u0900" <= c <= "\u097F" for c in spoken), f"spoken not in Nepali: {spoken}"
        # action_items can be empty or a list
        assert isinstance(data.get("action_items"), list)

    def test_image_pure_noise_returns_polite_message(self, api_client, base_url):
        b64 = _make_noise_png_b64()
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        # Must NOT be 500
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        # Either extracted_text empty + polite spoken_message, OR garbled but no crash
        spoken = (data.get("spoken_message") or "").strip()
        assert spoken, "spoken_message should be non-empty even for unreadable images"
        assert isinstance(data.get("action_items"), list)

    # ---------- Iteration 4: calendar_events ----------
    def test_image_bill_returns_calendar_event(self, api_client, base_url):
        b64 = _make_bill_png_b64()
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        events = data.get("calendar_events")
        assert isinstance(events, list), f"calendar_events not a list: {events}"
        assert len(events) >= 1, f"Expected at least 1 event, got: {events}"
        ev = events[0]
        # Schema check
        for key in ("title", "start_iso", "all_day", "type", "description"):
            assert key in ev, f"Missing key {key} in event: {ev}"
        # start_iso should be 2026-12-15 (or include it)
        assert ev["start_iso"].startswith("2026-12-15"), f"Unexpected date: {ev['start_iso']}"
        assert ev["type"] in ("bill", "deadline", "other"), f"Unexpected type: {ev['type']}"
        # title/description should be readable English (mostly ASCII letters)
        assert ev["title"].strip(), "title empty"
        # Should NOT be Devanagari per spec — calendar uses Latin
        assert not any("\u0900" <= c <= "\u097F" for c in ev["title"]), f"title in Devanagari: {ev['title']}"
        print("BILL calendar_event=", ev)

    def test_image_appointment_returns_timed_event(self, api_client, base_url):
        b64 = _make_appointment_png_b64()
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        events = data.get("calendar_events") or []
        assert isinstance(events, list)
        assert len(events) >= 1, f"Expected at least 1 event, got: {events}"
        ev = events[0]
        assert ev["start_iso"].startswith("2026-01-20"), f"Unexpected date: {ev['start_iso']}"
        # Should include time (T10:30)
        assert "T" in ev["start_iso"], f"Expected timed event, got: {ev['start_iso']}"
        assert "10:30" in ev["start_iso"], f"Expected 10:30 in start_iso: {ev['start_iso']}"
        assert ev["all_day"] is False, f"Expected all_day False, got: {ev['all_day']}"
        assert ev["type"] in ("appointment", "other"), f"Unexpected type: {ev['type']}"
        print("APPT calendar_event=", ev)

    def test_image_no_actionable_returns_empty_events(self, api_client, base_url):
        # Plain "HELLO WORLD" image — no dates → empty events
        b64 = _make_text_png_b64("HELLO WORLD")
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        events = data.get("calendar_events")
        assert events == [], f"Expected empty list, got: {events}"

    def test_image_relative_dates_returns_empty_events(self, api_client, base_url):
        b64 = _make_relative_date_png_b64()
        r = api_client.post(
            f"{base_url}/api/translate-image",
            json={"image_base64": b64, "mime_type": "image/png", "target_lang": "ne"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        events = data.get("calendar_events")
        assert isinstance(events, list)
        # 'tomorrow' is relative — spec says exclude → empty
        assert events == [], f"Expected empty list for relative date image, got: {events}"


# ------------------------------------------------------------
# /api/transcribe (Whisper)
# ------------------------------------------------------------
def _make_english_mp3_b64(phrase: str = "hello good morning") -> str:
    """Generate a tiny MP3 saying the given phrase using gTTS."""
    from gtts import gTTS
    buf = io.BytesIO()
    tts = gTTS(text=phrase, lang="en")
    tts.write_to_fp(buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class TestTranscribeAudio:
    def test_transcribe_english_phrase(self, api_client, base_url):
        b64 = _make_english_mp3_b64("hello good morning")
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"audio_base64": b64, "mime_type": "audio/mpeg", "language": "en"},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        text = (data.get("text") or "").strip().lower()
        assert text, f"empty transcript: {data}"
        # Whisper should pick up at least one of the spoken words
        assert any(w in text for w in ["hello", "good", "morning"]), f"unexpected transcript: {text}"
        lang = data.get("language")
        # Either 'en' or None tolerated per spec
        assert lang in (None, "en"), f"unexpected language: {lang}"
        print("Transcribe text =>", text, "| lang =>", lang)

    def test_transcribe_invalid_base64(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"audio_base64": "@@@not-base64@@@", "mime_type": "audio/mpeg"},
            timeout=30,
        )
        # Backend uses validate=False so garbage may decode to empty/short bytes
        # → expect 400 (either "Invalid base64 audio" OR "Audio is too short or empty")
        assert r.status_code == 400, r.text

    def test_transcribe_too_short(self, api_client, base_url):
        # 100 bytes of zeros → too short
        b64 = base64.b64encode(b"\x00" * 100).decode("ascii")
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"audio_base64": b64, "mime_type": "audio/wav"},
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "short" in r.text.lower() or "empty" in r.text.lower()

    def test_transcribe_oversized(self, api_client, base_url):
        # 26 MB of zeros → exceeds 25 MB
        big = b"\x00" * (26 * 1024 * 1024)
        b64 = base64.b64encode(big).decode("ascii")
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"audio_base64": b64, "mime_type": "audio/wav"},
            timeout=60,
        )
        assert r.status_code == 400, r.text
        assert "25" in r.text or "limit" in r.text.lower() or "exceed" in r.text.lower()

    def test_transcribe_missing_field_returns_422(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/transcribe",
            json={"mime_type": "audio/wav"},  # missing audio_base64
            timeout=30,
        )
        assert r.status_code == 422, r.text

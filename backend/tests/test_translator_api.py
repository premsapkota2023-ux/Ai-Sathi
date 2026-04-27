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

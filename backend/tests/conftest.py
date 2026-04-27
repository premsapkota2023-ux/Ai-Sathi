import os
import pytest
import requests


@pytest.fixture(scope="session")
def base_url() -> str:
    url = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
    if not url:
        # fallback to frontend .env
        try:
            with open("/app/frontend/.env") as f:
                for line in f:
                    if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                        url = line.strip().split("=", 1)[1].strip('"').strip("'")
                        break
        except Exception:
            pass
    assert url, "Backend URL not configured"
    return url.rstrip("/")


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s

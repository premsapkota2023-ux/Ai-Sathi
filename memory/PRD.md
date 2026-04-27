# AI Sathi — Product Requirements

## Overview
**AI Sathi** ("AI Friend" in Nepali) is a mobile translation app for English ↔ Nepali with voice output and image text translation (OCR).

## Stack
- **Frontend**: Expo React Native (single screen, expo-router)
- **Backend**: FastAPI (stateless — no DB persistence per user request)
- **Translation/OCR**: Google Gemini 2.5-pro via `emergentintegrations` + Emergent Universal LLM Key
- **Voice Output**: Device-native TTS via `expo-speech` (`en-US`, `ne-NP` locales)
- **Image Input**: `expo-image-picker` (camera + gallery)

## Features
1. **Text Translation** (debounced, 600ms): English ↔ Nepali via `POST /api/translate`
2. **Image OCR + Translation**: Upload/capture image → Gemini vision extracts text + detects language → translates to opposite language. `POST /api/translate-image`
3. **Voice Output**: Tap speaker icon to TTS-read translated text in target language
4. **Voice (source)**: Mic button reads back the source text
5. **Language Swap**: Pill toggle swaps FROM ↔ TO and source ↔ translated content
6. **Copy to clipboard** & **Clear** utilities
7. **No data is stored** — fully stateless per user requirement

## API
- `GET /api/` — health
- `POST /api/translate` `{text, source_lang, target_lang}` → `{translated_text, source_lang, target_lang}`
- `POST /api/translate-image` `{image_base64, mime_type, target_lang}` → `{extracted_text, translated_text, detected_lang, target_lang}`

## Design
"Himalayan Dawn" theme — warm terracotta `#D95D39` + forest green `#2B593F` on off-white `#FAFAF8`. Floating language pill, dual-card workspace, FAB toolbar (gallery / camera primary / mic).

## Permissions
- iOS: NSCameraUsageDescription, NSPhotoLibraryUsageDescription
- Android: CAMERA, READ_MEDIA_IMAGES

## Future Enhancements
- Translation history (currently disabled by user)
- Voice input (speech-to-text)
- Conversation mode / phrasebook
- Offline mode

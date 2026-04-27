import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Text,
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Keyboard,
  Pressable,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import {
  useAudioRecorder,
  RecordingPresets,
  AudioModule,
  setAudioModeAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

type Lang = "en" | "ne";

const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  ne: "नेपाली",
};

const PLACEHOLDER: Record<Lang, string> = {
  en: "Type something to translate…",
  ne: "अनुवाद गर्न केहि लेख्नुहोस्…",
};

// Choose best available voice for a language.
// Returns either { language } (default behaviour) or { voice } when an exact
// voice id is found. Falls back to the closest matching language code if the
// device doesn't have the exact locale (common for Nepali on iOS / web).
async function pickVoiceOptions(lang: Lang): Promise<{
  language?: string;
  voice?: string;
  available: boolean;
}> {
  const targets =
    lang === "ne"
      ? ["ne-NP", "ne-IN", "ne", "hi-IN", "hi"]
      : ["en-US", "en-GB", "en-IN", "en"];
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    if (!voices || voices.length === 0) {
      return { language: targets[0], available: true };
    }
    for (const t of targets) {
      const exact = voices.find(
        (v) => v.language?.toLowerCase() === t.toLowerCase()
      );
      if (exact) return { voice: exact.identifier, language: exact.language, available: true };
    }
    // partial prefix match
    for (const t of targets) {
      const prefix = t.split("-")[0].toLowerCase();
      const partial = voices.find((v) =>
        v.language?.toLowerCase().startsWith(prefix)
      );
      if (partial)
        return { voice: partial.identifier, language: partial.language, available: true };
    }
    // none found for desired lang; let the OS pick a default
    return { language: targets[0], available: false };
  } catch {
    return { language: targets[0], available: true };
  }
}

async function speakText(text: string, lang: Lang, onDone?: () => void) {
  if (!text || !text.trim()) {
    onDone?.();
    return;
  }
  try {
    Speech.stop();
  } catch {}
  // Ensure audio routes to the loud speaker (not earpiece) — important after recording.
  if (Platform.OS !== "web") {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
      });
    } catch {}
  }
  const opts = await pickVoiceOptions(lang);
  Speech.speak(text, {
    language: opts.language,
    voice: opts.voice,
    rate: 0.95,
    pitch: 1.0,
    volume: 1.0,
    onDone: () => onDone?.(),
    onStopped: () => onDone?.(),
    onError: () => onDone?.(),
  });
  return opts.available;
}

// ---------- Web camera modal (desktop browsers) ----------
function WebCameraModal({
  visible,
  onClose,
  onCapture,
}: {
  visible: boolean;
  onClose: () => void;
  onCapture: (base64: string, mime: string) => void;
}) {
  const videoContainerRef = useRef<View | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    let cancelled = false;
    setError(null);
    setReady(false);

    (async () => {
      try {
        // @ts-ignore - DOM only on web
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        // @ts-ignore
        const containerEl = videoContainerRef.current as unknown as HTMLElement;
        if (!containerEl) return;
        // @ts-ignore
        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "cover";
        video.style.borderRadius = "16px";
        video.srcObject = stream;
        // @ts-ignore
        containerEl.innerHTML = "";
        // @ts-ignore
        containerEl.appendChild(video);
        videoElRef.current = video;
        await video.play();
        setReady(true);
      } catch (e: any) {
        setError(e?.message || "Could not access camera");
      }
    })();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      videoElRef.current = null;
    };
  }, [visible]);

  const handleSnap = useCallback(() => {
    if (Platform.OS !== "web") return;
    const v = videoElRef.current;
    if (!v) return;
    // @ts-ignore
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const b64 = dataUrl.split(",")[1] || "";
    onCapture(b64, "image/jpeg");
  }, [onCapture]);

  if (Platform.OS !== "web") return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.cameraSheet}>
          <View style={styles.cameraHeader}>
            <Text style={styles.cameraTitle}>Take a photo</Text>
            <TouchableOpacity onPress={onClose} style={styles.cameraClose} testID="web-camera-close">
              <Ionicons name="close" size={22} color="#1C1917" />
            </TouchableOpacity>
          </View>
          {error ? (
            <View style={styles.cameraError}>
              <Ionicons name="alert-circle-outline" size={32} color="#B0341A" />
              <Text style={styles.cameraErrorText}>{error}</Text>
              <Text style={styles.cameraErrorHint}>
                Allow camera permission in your browser, or use the gallery button instead.
              </Text>
            </View>
          ) : (
            <>
              <View ref={videoContainerRef as any} style={styles.cameraVideo} />
              {!ready && (
                <View style={styles.cameraLoading}>
                  <ActivityIndicator color="#D95D39" />
                  <Text style={styles.cameraLoadingText}>Starting camera…</Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.snapButton}
                onPress={handleSnap}
                disabled={!ready}
                activeOpacity={0.85}
                testID="web-camera-snap"
              >
                <View style={styles.snapInner} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default function Index() {
  const [sourceLang, setSourceLang] = useState<Lang>("en");
  const [targetLang, setTargetLang] = useState<Lang>("ne");
  const [sourceText, setSourceText] = useState("");
  const [translated, setTranslated] = useState("");
  const [summary, setSummary] = useState("");
  const [actionItems, setActionItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [webCamOpen, setWebCamOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [keyboardEnabled, setKeyboardEnabled] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<TextInput | null>(null);

  // Audio recorder hook (expo-audio)
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    return () => {
      try {
        Speech.stop();
      } catch {}
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  const performSpeak = useCallback(
    async (text: string, lang: Lang) => {
      if (!text.trim()) return;
      setSpeaking(true);
      setVoiceWarning(null);
      const available = await speakText(text, lang, () => setSpeaking(false));
      if (available === false) {
        setVoiceWarning(
          lang === "ne"
            ? "No Nepali voice installed on this device — using a fallback voice."
            : "No matching English voice — using a fallback voice."
        );
      }
    },
    []
  );

  const swapLangs = useCallback(() => {
    setSourceLang((s) => {
      const newSrc: Lang = s === "en" ? "ne" : "en";
      setTargetLang(newSrc === "en" ? "ne" : "en");
      return newSrc;
    });
    setSourceText(translated);
    setTranslated(sourceText);
    setSummary("");
    setActionItems([]);
    setError(null);
  }, [sourceText, translated]);

  const callTranslate = useCallback(
    async (text: string, src: Lang, tgt: Lang, speakAfter: boolean) => {
      if (!text.trim()) {
        setTranslated("");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${BACKEND_URL}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, source_lang: src, target_lang: tgt }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const out = data.translated_text || "";
        setTranslated(out);
        setSummary("");
        setActionItems([]);
        if (speakAfter && autoSpeak && out) {
          performSpeak(out, tgt);
        }
      } catch (e: any) {
        setError(e?.message || "Translation failed");
        setTranslated("");
      } finally {
        setLoading(false);
      }
    },
    [autoSpeak, performSpeak]
  );

  const handleSourceChange = useCallback(
    (text: string) => {
      setSourceText(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!text.trim()) {
        setTranslated("");
        setSummary("");
        setActionItems([]);
        setError(null);
        return;
      }
      // debounced silent translate (no auto-speak while typing)
      debounceRef.current = setTimeout(() => {
        callTranslate(text, sourceLang, targetLang, false);
      }, 700);
    },
    [callTranslate, sourceLang, targetLang]
  );

  const handleTranslateNow = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    Keyboard.dismiss();
    callTranslate(sourceText, sourceLang, targetLang, true);
  }, [callTranslate, sourceText, sourceLang, targetLang]);

  const handleClear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSourceText("");
    setTranslated("");
    setSummary("");
    setActionItems([]);
    setError(null);
    setVoiceWarning(null);
    Speech.stop();
    setSpeaking(false);
  }, []);

  // ---------- Voice input (record → Whisper transcribe) ----------
  const startRecording = useCallback(async () => {
    try {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      Speech.stop();
      setSpeaking(false);
      setError(null);
      setVoiceWarning(null);

      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Microphone permission needed",
          "Please allow microphone access to use voice input."
        );
        return;
      }

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => {
          // hard cap at 60s
          if (s >= 59) {
            stopRecording();
            return 60;
          }
          return s + 1;
        });
      }, 1000);
    } catch (e: any) {
      setIsRecording(false);
      Alert.alert("Recording error", e?.message || "Could not start recording");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRecorder]);

  const stopRecording = useCallback(async () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setIsRecording(false);
    setTranscribing(true);
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) {
        throw new Error("No audio recorded");
      }

      // Read recorded file as base64
      let base64 = "";
      let mime = Platform.OS === "web" ? "audio/webm" : "audio/m4a";
      if (Platform.OS === "web") {
        // On web, uri is a blob: URL
        const resp = await fetch(uri);
        const blob = await resp.blob();
        mime = blob.type || mime;
        base64 = await new Promise<string>((resolve, reject) => {
          // @ts-ignore
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = (reader.result as string) || "";
            const idx = result.indexOf(",");
            resolve(idx >= 0 ? result.slice(idx + 1) : result);
          };
          reader.onerror = () => reject(new Error("Failed to read audio blob"));
          reader.readAsDataURL(blob);
        });
      } else {
        base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      const res = await fetch(`${BACKEND_URL}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_base64: base64,
          mime_type: mime,
          language: sourceLang,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Restore playback audio mode so subsequent TTS goes to the loud speaker
      // (iOS leaves the session in record mode which routes to the earpiece).
      if (Platform.OS !== "web") {
        try {
          await setAudioModeAsync({
            playsInSilentMode: true,
            allowsRecording: false,
          });
        } catch {}
      }
      const text = (data.text || "").trim();
      if (!text) {
        setError("Could not understand the audio. Please try speaking again.");
        return;
      }
      // Trust user's selected source language; use Whisper's detection only as a hint.
      const detected: Lang | null =
        data.language === "en" || data.language === "ne" ? data.language : null;
      let actualSrc: Lang = sourceLang;
      let actualTgt: Lang = targetLang;
      if (detected && detected !== sourceLang) {
        actualSrc = detected;
        actualTgt = detected === "en" ? "ne" : "en";
        setSourceLang(actualSrc);
        setTargetLang(actualTgt);
      }
      setSourceText(text);
      // Auto-translate the transcribed text and speak
      callTranslate(text, actualSrc, actualTgt, true);
    } catch (e: any) {
      setError(e?.message || "Could not transcribe audio");
    } finally {
      setTranscribing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRecorder, sourceLang, targetLang, callTranslate]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  const handleSpeakOutput = useCallback(() => {
    if (speaking) {
      Speech.stop();
      setSpeaking(false);
      return;
    }
    // Prefer the spoken summary message (if from image) else the translation
    const text = summary || translated;
    if (!text.trim()) return;
    performSpeak(text, targetLang);
  }, [speaking, summary, translated, targetLang, performSpeak]);

  const handleCopy = useCallback(async () => {
    const text = summary || translated;
    if (!text) return;
    await Clipboard.setStringAsync(text);
    if (Platform.OS === "web") return;
    Alert.alert("Copied", "Text copied to clipboard.");
  }, [translated, summary]);

  const processImage = useCallback(
    async (base64: string, mime: string) => {
      setImageBusy(true);
      setError(null);
      setSummary("");
      setActionItems([]);
      try {
        const res = await fetch(`${BACKEND_URL}/api/translate-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: base64,
            mime_type: mime,
            target_lang: targetLang,
          }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const extracted = (data.extracted_text || "").trim();
        const detected: Lang | undefined =
          data.detected_lang === "en" || data.detected_lang === "ne"
            ? data.detected_lang
            : undefined;

        if (!extracted) {
          setError("No readable text found in the image. Please try a clearer photo.");
          setTranslated("");
          if (autoSpeak) {
            performSpeak(
              targetLang === "ne"
                ? "कुनै पाठ भेटिएन। कृपया स्पष्ट तस्बिर खिच्नुहोस्।"
                : "No readable text found. Please try a clearer photo.",
              targetLang
            );
          }
          return;
        }

        if (detected) {
          setSourceLang(detected);
          setTargetLang(detected === "en" ? "ne" : "en");
        }
        setSourceText(extracted);
        const t = (data.translated_text || "").trim();
        const s = (data.summary || "").trim();
        const sm = (data.spoken_message || t).trim();
        const items: string[] = Array.isArray(data.action_items)
          ? data.action_items.filter((x: any) => typeof x === "string" && x.trim())
          : [];
        setTranslated(t);
        setSummary(s);
        setActionItems(items);
        if (autoSpeak && sm) {
          performSpeak(sm, (detected === "en" ? "ne" : detected === "ne" ? "en" : targetLang) as Lang);
        }
      } catch (e: any) {
        setError(e?.message || "Image translation failed");
      } finally {
        setImageBusy(false);
      }
    },
    [targetLang, autoSpeak, performSpeak]
  );

  const pickFromGallery = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Please allow photo library access.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
        base64: true,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = asset.mimeType || "image/jpeg";
      if (!asset.base64) {
        Alert.alert("Error", "Could not read image data.");
        return;
      }
      await processImage(asset.base64, mime);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not pick image");
    }
  }, [processImage]);

  const captureWithCamera = useCallback(async () => {
    if (Platform.OS === "web") {
      setWebCamOpen(true);
      return;
    }
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Please allow camera access.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
        base64: true,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = asset.mimeType || "image/jpeg";
      if (!asset.base64) {
        Alert.alert("Error", "Could not read image data.");
        return;
      }
      await processImage(asset.base64, mime);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not capture image");
    }
  }, [processImage]);

  const handleWebCapture = useCallback(
    (b64: string, mime: string) => {
      setWebCamOpen(false);
      processImage(b64, mime);
    },
    [processImage]
  );

  const showEmptyState = useMemo(
    () => !sourceText && !translated && !loading && !imageBusy && !error,
    [sourceText, translated, loading, imageBusy, error]
  );

  const hasOutput = !!(translated || summary);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        {/* Header */}
        <View style={styles.header} testID="app-header-logo">
          <Text style={styles.brand}>
            AI Sathi<Text style={styles.brandDot}>.</Text>
          </Text>
          <Pressable
            onPress={() => setAutoSpeak((v) => !v)}
            style={styles.autoSpeakChip}
            testID="auto-speak-toggle"
          >
            <Ionicons
              name={autoSpeak ? "volume-high" : "volume-mute"}
              size={14}
              color={autoSpeak ? "#2B593F" : "#A8A29E"}
            />
            <Text
              style={[
                styles.autoSpeakText,
                { color: autoSpeak ? "#2B593F" : "#A8A29E" },
              ]}
            >
              {autoSpeak ? "Auto-speak ON" : "Auto-speak OFF"}
            </Text>
          </Pressable>
        </View>

        {/* Language pill */}
        <View style={styles.langPillWrap}>
          <View style={styles.langPill}>
            <View style={styles.langSide}>
              <Text style={styles.langLabel}>FROM</Text>
              <Text style={styles.langValue}>{LANG_LABEL[sourceLang]}</Text>
            </View>
            <TouchableOpacity
              testID="language-swap-button"
              onPress={swapLangs}
              activeOpacity={0.7}
              style={styles.swapBtn}
            >
              <Ionicons name="swap-horizontal" size={20} color="#D95D39" />
            </TouchableOpacity>
            <View style={[styles.langSide, { alignItems: "flex-end" }]}>
              <Text style={styles.langLabel}>TO</Text>
              <Text style={styles.langValue}>{LANG_LABEL[targetLang]}</Text>
            </View>
          </View>
        </View>

        <Pressable onPress={Keyboard.dismiss} style={styles.workspace}>
          {/* Source input */}
          <View style={styles.inputCard}>
            <View style={styles.inputHeader}>
              <Text style={styles.cardLabel}>{LANG_LABEL[sourceLang]}</Text>
              {(isRecording || transcribing) && (
                <View style={styles.recordingPill}>
                  {isRecording ? (
                    <>
                      <View style={styles.recordingDot} />
                      <Text style={styles.recordingText}>
                        Recording  {recordSeconds}s
                      </Text>
                    </>
                  ) : (
                    <>
                      <ActivityIndicator size="small" color="#D95D39" />
                      <Text style={styles.recordingText}>Transcribing…</Text>
                    </>
                  )}
                </View>
              )}
            </View>
            <ScrollView
              style={styles.scroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <TextInput
                ref={inputRef}
                testID="source-text-input"
                style={styles.textInput}
                multiline
                value={sourceText}
                onChangeText={handleSourceChange}
                placeholder={
                  keyboardEnabled
                    ? PLACEHOLDER[sourceLang]
                    : "Tap the mic to speak, or the keyboard icon to type…"
                }
                placeholderTextColor="#A8A29E"
                maxLength={5000}
                autoCorrect
                autoCapitalize="sentences"
                textAlignVertical="top"
                editable={keyboardEnabled}
                showSoftInputOnFocus={keyboardEnabled}
                onBlur={() => setKeyboardEnabled(false)}
              />
            </ScrollView>
            <View style={styles.utilityRow}>
              <Text style={styles.charCount}>{sourceText.length}/5000</Text>
              <View style={styles.utilityActions}>
                {sourceText.length > 0 && (
                  <TouchableOpacity
                    testID="clear-text-button"
                    onPress={handleClear}
                    style={styles.iconGhost}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="close" size={18} color="#A8A29E" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  testID="toggle-keyboard-button"
                  onPress={() => {
                    if (keyboardEnabled) {
                      Keyboard.dismiss();
                      setKeyboardEnabled(false);
                    } else {
                      setKeyboardEnabled(true);
                      // focus on next tick so editable=true is committed first
                      setTimeout(() => inputRef.current?.focus(), 50);
                    }
                  }}
                  style={[
                    styles.iconGhost,
                    keyboardEnabled && styles.iconGhostActive,
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={keyboardEnabled ? "keypad" : "keypad-outline"}
                    size={18}
                    color={keyboardEnabled ? "#fff" : "#57534E"}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  testID="speak-source-button"
                  onPress={toggleRecording}
                  disabled={transcribing || loading || imageBusy}
                  style={[
                    styles.iconGhost,
                    isRecording && styles.iconRecording,
                    (transcribing || loading || imageBusy) && { opacity: 0.4 },
                  ]}
                  activeOpacity={0.7}
                >
                  {transcribing ? (
                    <ActivityIndicator size="small" color="#D95D39" />
                  ) : (
                    <Ionicons
                      name={isRecording ? "stop" : "mic"}
                      size={18}
                      color={isRecording ? "#fff" : "#D95D39"}
                    />
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  testID="translate-now-button"
                  onPress={handleTranslateNow}
                  disabled={!sourceText.trim() || loading}
                  style={[
                    styles.translateBtn,
                    (!sourceText.trim() || loading) && styles.translateBtnDisabled,
                  ]}
                  activeOpacity={0.85}
                >
                  <Ionicons name="arrow-forward" size={16} color="#fff" />
                  <Text style={styles.translateBtnText}>Translate</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* Output */}
          <View style={styles.outputCard}>
            <View style={styles.outputHeader}>
              <Text style={[styles.cardLabel, styles.cardLabelOutput]}>
                {LANG_LABEL[targetLang]}
              </Text>
              {summary ? (
                <View style={styles.summaryBadge}>
                  <Ionicons name="document-text-outline" size={11} color="#2B593F" />
                  <Text style={styles.summaryBadgeText}>Document summary</Text>
                </View>
              ) : null}
            </View>

            {showEmptyState ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <Ionicons name="sparkles-outline" size={28} color="#D95D39" />
                </View>
                <Text style={styles.emptyTitle}>Translate anything</Text>
                <Text style={styles.emptyDesc}>
                  Type, snap a photo of a bill or letter, or pick from gallery — AI Sathi will
                  translate, summarize, and read it aloud.
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
                {loading || imageBusy ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator color="#D95D39" />
                    <Text style={styles.loadingText}>
                      {imageBusy ? "Reading & summarizing image…" : "Translating…"}
                    </Text>
                  </View>
                ) : error ? (
                  <Text style={styles.errorText}>{error}</Text>
                ) : (
                  <View>
                    {summary ? (
                      <Text style={styles.outputText} selectable testID="translated-text-output">
                        {summary}
                      </Text>
                    ) : (
                      <Text style={styles.outputText} selectable testID="translated-text-output">
                        {translated || " "}
                      </Text>
                    )}

                    {actionItems.length > 0 && (
                      <View style={styles.actionsBox}>
                        <Text style={styles.actionsTitle}>
                          {targetLang === "ne" ? "गर्नुपर्ने कामहरू" : "Action items"}
                        </Text>
                        {actionItems.map((it, i) => (
                          <View key={i} style={styles.actionRow}>
                            <View style={styles.actionDot} />
                            <Text style={styles.actionText}>{it}</Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {summary && translated ? (
                      <View style={styles.fullTranslationBox}>
                        <Text style={styles.fullTranslationLabel}>Full translation</Text>
                        <Text style={styles.fullTranslationText} selectable>
                          {translated}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                )}

                {voiceWarning && hasOutput && !loading && !imageBusy && (
                  <Text style={styles.voiceWarn}>{voiceWarning}</Text>
                )}
              </ScrollView>
            )}

            {hasOutput && !loading && !imageBusy && (
              <View style={styles.outputActions}>
                <TouchableOpacity
                  testID="copy-clipboard-button"
                  onPress={handleCopy}
                  style={styles.outputActionBtn}
                  activeOpacity={0.7}
                >
                  <Ionicons name="copy-outline" size={18} color="#57534E" />
                </TouchableOpacity>
                <TouchableOpacity
                  testID="play-audio-button"
                  onPress={handleSpeakOutput}
                  style={[
                    styles.outputActionBtn,
                    styles.outputActionPrimary,
                    speaking && styles.outputActionBtnActive,
                  ]}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={speaking ? "stop" : "volume-high"}
                    size={18}
                    color="#fff"
                  />
                  <Text style={styles.outputActionPrimaryText}>
                    {speaking ? "Stop" : "Play"}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </Pressable>

        {/* Bottom toolbar */}
        <View style={styles.bottomBar}>
          <TouchableOpacity
            testID="gallery-upload-button"
            onPress={pickFromGallery}
            disabled={imageBusy}
            style={styles.secondaryFab}
            activeOpacity={0.8}
          >
            <Ionicons name="images-outline" size={22} color="#57534E" />
          </TouchableOpacity>
          <TouchableOpacity
            testID="camera-capture-button"
            onPress={captureWithCamera}
            disabled={imageBusy}
            style={styles.primaryFab}
            activeOpacity={0.85}
          >
            {imageBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons name="camera" size={26} color="#fff" />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            testID="reset-app-button"
            onPress={handleClear}
            disabled={!sourceText && !translated}
            style={[
              styles.secondaryFab,
              !sourceText && !translated && styles.secondaryFabDisabled,
            ]}
            activeOpacity={0.8}
          >
            <Ionicons name="refresh" size={22} color="#57534E" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <WebCameraModal
        visible={webCamOpen}
        onClose={() => setWebCamOpen(false)}
        onCapture={handleWebCapture}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FAFAF8" },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 6,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  brand: {
    fontSize: 26,
    fontWeight: "800",
    color: "#1C1917",
    letterSpacing: -0.5,
  },
  brandDot: { color: "#D95D39" },
  autoSpeakChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(43,89,63,0.08)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  autoSpeakText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  langPillWrap: { paddingHorizontal: 16, marginBottom: 8, marginTop: 4 },
  langPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E5E4",
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    elevation: 2,
  },
  langSide: { flex: 1 },
  langLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#A8A29E",
    letterSpacing: 1.6,
    marginBottom: 2,
  },
  langValue: { fontSize: 15, fontWeight: "700", color: "#1C1917" },
  swapBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#FAFAF8",
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 12,
  },
  workspace: { flex: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 12 },
  inputCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EFECE6",
    minHeight: 140,
  },
  inputHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  recordingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(217,93,57,0.1)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#D95D39",
  },
  recordingText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#D95D39",
    letterSpacing: 0.4,
  },
  outputCard: {
    flex: 1.1,
    backgroundColor: "#F4F1EA",
    borderRadius: 28,
    padding: 18,
    minHeight: 160,
    overflow: "hidden",
  },
  outputHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#A8A29E",
    letterSpacing: 1.6,
  },
  cardLabelOutput: { color: "#8A7B5C" },
  summaryBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(43,89,63,0.12)",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  summaryBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#2B593F",
    letterSpacing: 0.4,
  },
  scroll: { flex: 1 },
  textInput: {
    flex: 1,
    fontSize: 22,
    color: "#1C1917",
    lineHeight: 30,
    fontWeight: "500",
    minHeight: 80,
    padding: 0,
    margin: 0,
  },
  utilityRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  charCount: { fontSize: 11, color: "#A8A29E", fontWeight: "600" },
  utilityActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconGhost: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGhostActive: {
    backgroundColor: "#1C1917",
  },
  iconRecording: {
    backgroundColor: "#D95D39",
  },
  translateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1C1917",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  translateBtnDisabled: { opacity: 0.4 },
  translateBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  outputText: {
    fontSize: 20,
    color: "#1C1917",
    lineHeight: 28,
    fontWeight: "500",
  },
  actionsBox: {
    marginTop: 14,
    backgroundColor: "rgba(255,255,255,0.65)",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(43,89,63,0.18)",
  },
  actionsTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2B593F",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  actionRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  actionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#D95D39",
    marginTop: 8,
  },
  actionText: { flex: 1, fontSize: 14, color: "#1C1917", lineHeight: 20 },
  fullTranslationBox: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(168,162,158,0.3)",
  },
  fullTranslationLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#A8A29E",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  fullTranslationText: { fontSize: 14, color: "#57534E", lineHeight: 20 },
  voiceWarn: {
    fontSize: 11,
    color: "#92651D",
    marginTop: 8,
    fontStyle: "italic",
  },
  outputActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  outputActionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  outputActionPrimary: {
    backgroundColor: "#2B593F",
    width: "auto",
    paddingHorizontal: 18,
    flexDirection: "row",
    gap: 6,
  },
  outputActionPrimaryText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  outputActionBtnActive: { backgroundColor: "#B0341A" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(217,93,57,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1C1917",
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 13,
    color: "#78716C",
    textAlign: "center",
    lineHeight: 19,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  loadingText: { fontSize: 14, color: "#78716C", fontWeight: "500" },
  errorText: { fontSize: 14, color: "#B0341A", lineHeight: 20 },
  bottomBar: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 18,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === "ios" ? 8 : 14,
    paddingTop: 6,
  },
  primaryFab: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#D95D39",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },
  secondaryFab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E5E4",
    alignItems: "center",
    justifyContent: "center",
    elevation: 2,
  },
  secondaryFabDisabled: { opacity: 0.5 },

  // Web camera modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(28,25,23,0.85)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  cameraSheet: {
    width: "100%",
    maxWidth: 480,
    backgroundColor: "#FAFAF8",
    borderRadius: 28,
    padding: 18,
  },
  cameraHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  cameraTitle: { fontSize: 18, fontWeight: "700", color: "#1C1917" },
  cameraClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F4F1EA",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraVideo: {
    width: "100%",
    aspectRatio: 4 / 3,
    backgroundColor: "#1C1917",
    borderRadius: 16,
    overflow: "hidden",
  },
  cameraLoading: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 8,
  },
  cameraLoadingText: { fontSize: 13, color: "#fff", fontWeight: "600" },
  cameraError: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
  },
  cameraErrorText: {
    fontSize: 14,
    color: "#B0341A",
    fontWeight: "600",
    textAlign: "center",
  },
  cameraErrorHint: {
    fontSize: 12,
    color: "#78716C",
    textAlign: "center",
    paddingHorizontal: 12,
  },
  snapButton: {
    alignSelf: "center",
    marginTop: 16,
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#1C1917",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  snapInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#D95D39",
  },
});

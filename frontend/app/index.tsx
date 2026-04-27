import React, { useState, useCallback, useMemo, useRef } from "react";
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
  TouchableWithoutFeedback,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

type Lang = "en" | "ne";

const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  ne: "नेपाली",
};

const SPEECH_LOCALE: Record<Lang, string> = {
  en: "en-US",
  ne: "ne-NP",
};

const PLACEHOLDER: Record<Lang, string> = {
  en: "Type something to translate…",
  ne: "अनुवाद गर्न केहि लेख्नुहोस्…",
};

export default function Index() {
  const [sourceLang, setSourceLang] = useState<Lang>("en");
  const [targetLang, setTargetLang] = useState<Lang>("ne");
  const [sourceText, setSourceText] = useState("");
  const [translated, setTranslated] = useState("");
  const [loading, setLoading] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const swapLangs = useCallback(() => {
    setSourceLang((s) => {
      const newSrc: Lang = s === "en" ? "ne" : "en";
      setTargetLang(newSrc === "en" ? "ne" : "en");
      return newSrc;
    });
    setSourceText(translated);
    setTranslated(sourceText);
    setError(null);
  }, [sourceText, translated]);

  const callTranslate = useCallback(
    async (text: string, src: Lang, tgt: Lang) => {
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
        setTranslated(data.translated_text || "");
      } catch (e: any) {
        setError(e?.message || "Translation failed");
        setTranslated("");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleSourceChange = useCallback(
    (text: string) => {
      setSourceText(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!text.trim()) {
        setTranslated("");
        setError(null);
        return;
      }
      debounceRef.current = setTimeout(() => {
        callTranslate(text, sourceLang, targetLang);
      }, 600);
    },
    [callTranslate, sourceLang, targetLang]
  );

  const handleTranslateNow = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    Keyboard.dismiss();
    callTranslate(sourceText, sourceLang, targetLang);
  }, [callTranslate, sourceText, sourceLang, targetLang]);

  const handleClear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSourceText("");
    setTranslated("");
    setError(null);
    Speech.stop();
    setSpeaking(false);
  }, []);

  const handleSpeak = useCallback(() => {
    if (!translated.trim()) return;
    if (speaking) {
      Speech.stop();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    Speech.speak(translated, {
      language: SPEECH_LOCALE[targetLang],
      rate: 0.95,
      pitch: 1.0,
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, [translated, speaking, targetLang]);

  const handleCopy = useCallback(async () => {
    if (!translated) return;
    await Clipboard.setStringAsync(translated);
    if (Platform.OS === "web") return; // silent on web
    Alert.alert("Copied", "Translated text copied to clipboard.");
  }, [translated]);

  const processImage = useCallback(
    async (base64: string, mime: string) => {
      setImageBusy(true);
      setError(null);
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
          setError("No readable text found in the image.");
          return;
        }

        // Sync UI: source = detected lang + extracted text, output = translated
        if (detected) {
          setSourceLang(detected);
          setTargetLang(detected === "en" ? "ne" : "en");
        }
        setSourceText(extracted);
        setTranslated((data.translated_text || "").trim());
      } catch (e: any) {
        setError(e?.message || "Image translation failed");
      } finally {
        setImageBusy(false);
      }
    },
    [targetLang]
  );

  const pickFromGallery = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Please allow photo library access.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

  const showEmptyState = useMemo(
    () => !sourceText && !translated && !loading && !imageBusy,
    [sourceText, translated, loading, imageBusy]
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {/* Header */}
        <View style={styles.header} testID="app-header-logo">
          <Text style={styles.brand}>
            AI Sathi<Text style={styles.brandDot}>.</Text>
          </Text>
          <Text style={styles.tagline}>English ↔ नेपाली</Text>
        </View>

        {/* Language selector pill */}
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

        {/* Workspace */}
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.workspace}>
            {/* Source input card */}
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>{LANG_LABEL[sourceLang]}</Text>
              <ScrollView
                style={styles.scroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <TextInput
                  testID="source-text-input"
                  style={styles.textInput}
                  multiline
                  value={sourceText}
                  onChangeText={handleSourceChange}
                  placeholder={PLACEHOLDER[sourceLang]}
                  placeholderTextColor="#A8A29E"
                  maxLength={5000}
                  autoCorrect
                  autoCapitalize="sentences"
                  textAlignVertical="top"
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
                    testID="translate-now-button"
                    onPress={handleTranslateNow}
                    disabled={!sourceText.trim() || loading}
                    style={[
                      styles.translateBtn,
                      (!sourceText.trim() || loading) && styles.translateBtnDisabled,
                    ]}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="arrow-forward" size={16} color="#fff" />
                    <Text style={styles.translateBtnText}>Translate</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Output card */}
            <View style={styles.outputCard}>
              <Text style={[styles.cardLabel, styles.cardLabelOutput]}>
                {LANG_LABEL[targetLang]}
              </Text>

              {showEmptyState ? (
                <View style={styles.emptyState}>
                  <View style={styles.emptyIcon}>
                    <Ionicons name="sparkles-outline" size={28} color="#D95D39" />
                  </View>
                  <Text style={styles.emptyTitle}>Translate anything</Text>
                  <Text style={styles.emptyDesc}>
                    Type, paste, snap a photo, or pick from gallery — AI Sathi will translate &
                    speak it back.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  style={styles.scroll}
                  showsVerticalScrollIndicator={false}
                >
                  {loading || imageBusy ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color="#D95D39" />
                      <Text style={styles.loadingText}>
                        {imageBusy ? "Reading image…" : "Translating…"}
                      </Text>
                    </View>
                  ) : error ? (
                    <Text style={styles.errorText}>{error}</Text>
                  ) : (
                    <Text
                      style={styles.outputText}
                      selectable
                      testID="translated-text-output"
                    >
                      {translated || " "}
                    </Text>
                  )}
                </ScrollView>
              )}

              {!!translated && !loading && !imageBusy && (
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
                    onPress={handleSpeak}
                    style={[
                      styles.outputActionBtn,
                      speaking && styles.outputActionBtnActive,
                    ]}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={speaking ? "stop" : "volume-high"}
                      size={18}
                      color={speaking ? "#fff" : "#2B593F"}
                    />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </TouchableWithoutFeedback>

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
            testID="speak-source-button"
            onPress={() => {
              if (!sourceText.trim()) return;
              Speech.stop();
              Speech.speak(sourceText, {
                language: SPEECH_LOCALE[sourceLang],
                rate: 0.95,
              });
            }}
            disabled={!sourceText.trim()}
            style={[
              styles.secondaryFab,
              !sourceText.trim() && styles.secondaryFabDisabled,
            ]}
            activeOpacity={0.8}
          >
            <Ionicons name="mic-outline" size={22} color="#57534E" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FAFAF8" },
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 8,
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
  tagline: {
    fontSize: 12,
    color: "#78716C",
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  langPillWrap: {
    paddingHorizontal: 16,
    marginBottom: 8,
    marginTop: 4,
  },
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
    shadowColor: "#1C1917",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
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
  langValue: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1C1917",
  },
  swapBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#FAFAF8",
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 12,
  },
  workspace: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 12,
  },
  inputCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EFECE6",
    minHeight: 160,
  },
  outputCard: {
    flex: 1,
    backgroundColor: "#F4F1EA",
    borderRadius: 28,
    padding: 18,
    minHeight: 160,
    overflow: "hidden",
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#A8A29E",
    letterSpacing: 1.6,
    marginBottom: 6,
  },
  cardLabelOutput: { color: "#8A7B5C" },
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
  utilityActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconGhost: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  translateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1C1917",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  translateBtnDisabled: { opacity: 0.4 },
  translateBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  outputText: {
    fontSize: 22,
    color: "#1C1917",
    lineHeight: 30,
    fontWeight: "500",
  },
  outputActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 10,
  },
  outputActionBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  outputActionBtnActive: { backgroundColor: "#2B593F" },
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
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
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
    shadowColor: "#D95D39",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
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
    shadowColor: "#1C1917",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  secondaryFabDisabled: { opacity: 0.5 },
});

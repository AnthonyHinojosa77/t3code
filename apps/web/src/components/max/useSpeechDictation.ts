import { useRef, useState } from "react";

interface RecognitionAlternativeLike {
  readonly transcript: string;
}
interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternativeLike;
}
interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResultLike };
}
interface RecognitionErrorEventLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  navigator: Navigator & { standalone?: boolean };
};

/**
 * Safari 14.1+ exposes the prefixed constructor (MDN browser-compat-data,
 * api/SpeechRecognition.json). WebKit bug 225298 keeps it unavailable inside Home Screen web apps
 * and SafariViewController, so a standalone iOS install gets a plain explanation.
 */
export const DICTATION_STANDALONE_MESSAGE =
  "Dictation isn’t available in the Home Screen app on iPhone yet. Open MAX in Safari to dictate, or type your question.";
export const DICTATION_UNSUPPORTED_MESSAGE =
  "Dictation isn’t available in this browser. Chrome, Edge and Safari support it; type your question instead.";
const DICTATION_BLOCKED_MESSAGE =
  "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.";
const DICTATION_NO_SPEECH_MESSAGE = "No speech was heard. Tap the mic and try again.";

export type DictationSupport = "supported" | "standalone-ios" | "unsupported";

export function detectDictationSupport(win: SpeechWindow | undefined): DictationSupport {
  if (!win) return "unsupported";
  const constructor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!constructor) return "unsupported";
  if (win.navigator.standalone === true && /iPhone|iPad|iPod/.test(win.navigator.userAgent)) {
    return "standalone-ios";
  }
  return "supported";
}

export function explainDictationError(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return DICTATION_BLOCKED_MESSAGE;
    case "no-speech":
      return DICTATION_NO_SPEECH_MESSAGE;
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Dictation needs a network connection.";
    case "aborted":
      return "";
    default:
      return "Dictation stopped unexpectedly. Try again.";
  }
}

export type DictationState = "idle" | "listening";

/** Browser speech recognition that fills a text field; the text stays editable before sending. */
export function useSpeechDictation(onTranscript: (text: string, isFinal: boolean) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const support = detectDictationSupport(
    typeof window === "undefined" ? undefined : (window as SpeechWindow),
  );

  const stop = () => {
    recognition.current?.stop();
  };

  const start = () => {
    const win = window as SpeechWindow;
    const Constructor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!Constructor) {
      setMessage(DICTATION_UNSUPPORTED_MESSAGE);
      return;
    }
    const instance = new Constructor();
    instance.lang = navigator.language || "en-US";
    // One phrase per press: iOS keeps the mic open in continuous mode without returning finals.
    instance.continuous = false;
    instance.interimResults = true;
    instance.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) onTranscript(transcript, true);
        else interim += transcript;
      }
      if (interim) onTranscript(interim, false);
    };
    instance.onerror = (event) => {
      const explanation = explainDictationError(event.error);
      if (explanation)
        setMessage(support === "standalone-ios" ? DICTATION_STANDALONE_MESSAGE : explanation);
    };
    instance.onend = () => {
      recognition.current = null;
      setState("idle");
    };
    recognition.current = instance;
    setMessage(null);
    try {
      instance.start();
      setState("listening");
    } catch {
      recognition.current = null;
      setMessage(
        support === "standalone-ios" ? DICTATION_STANDALONE_MESSAGE : DICTATION_UNSUPPORTED_MESSAGE,
      );
    }
  };

  const toggle = () => {
    if (state === "listening") stop();
    else start();
  };

  return { state, message, support, toggle, stop, dismissMessage: () => setMessage(null) } as const;
}

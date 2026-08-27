import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { useLanguage } from "../../context/LanguageContext";
import "./VoiceDescribe.css";

interface VoiceRecorderProps {
  onSubmit: (blob: Blob) => void;
  onFallback: () => void;
}

type RecordState = "idle" | "recording" | "recorded";

function MicIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

function RetakeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function VoiceRecorder({ onSubmit, onFallback }: VoiceRecorderProps) {
  const { t } = useLanguage();
  const [state, setState] = useState<RecordState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function handleStart() {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onFallback();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setState("recorded");
      };

      recorder.start();
      setElapsedSeconds(0);
      setState("recording");
      timerRef.current = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    } catch {
      onFallback();
    }
  }

  function handleStop() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    mediaRecorderRef.current?.stop();
  }

  function handleReRecord() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setElapsedSeconds(0);
    setState("idle");
  }

  if (state === "recorded" && audioBlob && audioUrl) {
    return (
      <div className="describe-screen describe-screen-center">
        <p className="body-s voice-recorded-hint">{t("voice.reviewRecording")}</p>
        <audio controls src={audioUrl} className="voice-player" />
        <div className="voice-recorded-actions">
          <Button variant="secondary" icon={<RetakeIcon />} onClick={handleReRecord}>
            {t("voice.reRecord")}
          </Button>
          <Button variant="primary" icon={<ArrowIcon />} onClick={() => onSubmit(audioBlob)}>
            {t("voice.continue")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="describe-screen describe-screen-center">
      {state === "recording" && (
        <div className="voice-bars" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      )}

      {state === "recording" && <p className="voice-timer">{formatTime(elapsedSeconds)}</p>}

      <button
        type="button"
        className={`voice-record-button${state === "recording" ? " voice-record-button-active" : ""}`}
        onClick={state === "recording" ? handleStop : handleStart}
        aria-label={state === "recording" ? t("voice.stop") : t("voice.record")}
      >
        {state === "recording" ? <StopIcon /> : <MicIcon />}
      </button>

      <p className="body-s voice-instruction">
        {state === "recording" ? t("voice.recording") : t("voice.tapToRecord")}
      </p>
    </div>
  );
}

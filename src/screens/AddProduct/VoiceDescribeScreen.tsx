import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { CategoryStep } from "./CategoryStep";
import { VoiceRecorder } from "./VoiceRecorder";
import { DescriptionEditor } from "./DescriptionEditor";
import { transcribeAndDescribe } from "../../services/api";
import { toWavBlob } from "../../services/audio";
import { useAddProductDraft } from "../../context/AddProductDraftContext";
import { useLanguage } from "../../context/LanguageContext";
import "./VoiceDescribe.css";

type Phase = "category" | "record" | "transcribing" | "transcribe-error" | "review";

function RetakeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function VoiceDescribeScreen() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const { draft, updateDraft } = useAddProductDraft();

  const [phase, setPhase] = useState<Phase>("category");
  const [category, setCategory] = useState<string | null>(draft.category ?? null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [descriptionEn, setDescriptionEn] = useState(draft.descriptionEn ?? "");
  const [descriptionLocal, setDescriptionLocal] = useState(draft.descriptionLocal ?? "");
  const [fallbackNote, setFallbackNote] = useState(false);

  const hasPhoto = Boolean(draft.imageUrl);

  useEffect(() => {
    if (!hasPhoto) {
      navigate("/add-product/photo", { replace: true });
    }
  }, [hasPhoto, navigate]);

  if (!hasPhoto) return null;

  function handleCategoryContinue(selected: string) {
    setCategory(selected);
    updateDraft({ category: selected });
    setPhase("record");
  }

  async function handleRecordingSubmit(blob: Blob) {
    setAudioBlob(blob);
    setPhase("transcribing");

    try {
      const audio = await toWavBlob(blob);
      const result = await transcribeAndDescribe(audio, category ?? "other", language);
      setDescriptionEn(result.descriptionEn);
      setDescriptionLocal(result.descriptionLocal);
      setFallbackNote(false);
      setPhase("review");
    } catch {
      setPhase("transcribe-error");
    }
  }

  function handleRetryTranscribe() {
    if (audioBlob) handleRecordingSubmit(audioBlob);
  }

  function handleMicFallback() {
    setFallbackNote(true);
    setPhase("review");
  }

  function handleDescriptionContinue() {
    updateDraft({ descriptionEn, descriptionLocal });
    navigate("/add-product/price");
  }

  if (phase === "category") {
    return <CategoryStep initialCategory={category} onContinue={handleCategoryContinue} />;
  }

  if (phase === "record") {
    return <VoiceRecorder onSubmit={handleRecordingSubmit} onFallback={handleMicFallback} />;
  }

  if (phase === "transcribing") {
    return (
      <div className="describe-screen describe-screen-center">
        <span className="describe-spinner" aria-hidden="true" />
        <p className="body-s">{t("describe.transcribing")}</p>
      </div>
    );
  }

  if (phase === "transcribe-error") {
    return (
      <div className="describe-screen describe-screen-center describe-loading">
        <p className="body-s onboarding-error" role="alert">
          {t("describe.transcribeError")}
        </p>
        <Button variant="primary" icon={<RetakeIcon />} onClick={handleRetryTranscribe}>
          {t("describe.retry")}
        </Button>
      </div>
    );
  }

  return (
    <DescriptionEditor
      descriptionEn={descriptionEn}
      descriptionLocal={descriptionLocal}
      onChangeEn={setDescriptionEn}
      onChangeLocal={setDescriptionLocal}
      onContinue={handleDescriptionContinue}
      note={fallbackNote ? t("describe.fallbackNote") : undefined}
    />
  );
}

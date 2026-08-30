import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { useLanguage } from "../../context/LanguageContext";
import "./VoiceDescribe.css";

interface DescriptionEditorProps {
  descriptionEn: string;
  descriptionLocal: string;
  onChangeEn: (value: string) => void;
  onChangeLocal: (value: string) => void;
  onContinue: () => void;
  note?: ReactNode;
}

type Tab = "en" | "local";

export function DescriptionEditor({
  descriptionEn,
  descriptionLocal,
  onChangeEn,
  onChangeLocal,
  onContinue,
  note,
}: DescriptionEditorProps) {
  const { language, t } = useLanguage();
  const [tab, setTab] = useState<Tab>("en");
  const localLabel = language === "en" ? t("language.en") : t("describe.localTab");

  const canContinue = descriptionEn.trim().length > 0 || descriptionLocal.trim().length > 0;

  return (
    <div className="describe-screen">
      {note && <p className="body-s description-note">{note}</p>}
      <p className="caption description-hint">{t("describe.reviewHint")}</p>

      <div className="language-toggle" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "en"}
          className={`language-option${tab === "en" ? " language-option-active" : ""}`}
          onClick={() => setTab("en")}
        >
          {t("language.en")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "local"}
          className={`language-option${tab === "local" ? " language-option-active" : ""}`}
          onClick={() => setTab("local")}
        >
          {localLabel}
        </button>
      </div>

      {tab === "en" ? (
        <textarea
          className="description-textarea"
          value={descriptionEn}
          onChange={(event) => onChangeEn(event.target.value)}
          placeholder={t("describe.placeholderEn")}
          lang="en"
          rows={8}
        />
      ) : (
        <textarea
          className="description-textarea"
          value={descriptionLocal}
          onChange={(event) => onChangeLocal(event.target.value)}
          placeholder={t("describe.placeholderLocal")}
          lang={language}
          rows={8}
        />
      )}

      <Button variant="primary" disabled={!canContinue} onClick={onContinue}>
        {t("describe.continue")}
      </Button>
    </div>
  );
}

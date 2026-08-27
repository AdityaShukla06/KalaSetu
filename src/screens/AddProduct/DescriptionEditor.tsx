import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { useLanguage } from "../../context/LanguageContext";
import "./VoiceDescribe.css";

interface DescriptionEditorProps {
  descriptionEn: string;
  descriptionHi: string;
  onChangeEn: (value: string) => void;
  onChangeHi: (value: string) => void;
  onContinue: () => void;
  note?: ReactNode;
}

type Tab = "en" | "hi";

export function DescriptionEditor({
  descriptionEn,
  descriptionHi,
  onChangeEn,
  onChangeHi,
  onContinue,
  note,
}: DescriptionEditorProps) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("en");

  const canContinue = descriptionEn.trim().length > 0 || descriptionHi.trim().length > 0;

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
          aria-selected={tab === "hi"}
          className={`language-option${tab === "hi" ? " language-option-active" : ""}`}
          onClick={() => setTab("hi")}
        >
          {t("language.hi")}
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
          value={descriptionHi}
          onChange={(event) => onChangeHi(event.target.value)}
          placeholder={t("describe.placeholderHi")}
          lang="hi"
          rows={8}
        />
      )}

      <Button variant="primary" disabled={!canContinue} onClick={onContinue}>
        {t("describe.continue")}
      </Button>
    </div>
  );
}

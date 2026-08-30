import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { LanguageTabs, type DescriptionTab } from "../../components/LanguageTabs";
import { useLanguage } from "../../context/LanguageContext";
import { useMirroredDescription } from "./useMirroredDescription";
import "./VoiceDescribe.css";

interface DescriptionEditorProps {
  descriptionEn: string;
  descriptionLocal: string;
  onChangeEn: (value: string) => void;
  onChangeLocal: (value: string) => void;
  onContinue: () => void;
  note?: ReactNode;
}

export function DescriptionEditor({
  descriptionEn,
  descriptionLocal,
  onChangeEn,
  onChangeLocal,
  onContinue,
  note,
}: DescriptionEditorProps) {
  const { language, t } = useLanguage();
  const [tab, setTab] = useState<DescriptionTab>("en");

  const { status, editEn, editLocal, sameLanguage } = useMirroredDescription({
    language,
    descriptionEn,
    descriptionLocal,
    onChangeEn,
    onChangeLocal,
  });

  const canContinue = descriptionEn.trim().length > 0 || descriptionLocal.trim().length > 0;

  return (
    <div className="describe-screen">
      {note && <p className="body-s description-note">{note}</p>}
      <p className="caption description-hint">{t("describe.reviewHint")}</p>

      <LanguageTabs value={tab} onChange={setTab} />

      {tab === "en" ? (
        <textarea
          className="description-textarea"
          value={descriptionEn}
          onChange={(event) => editEn(event.target.value)}
          placeholder={t("describe.placeholderEn")}
          lang="en"
          rows={8}
        />
      ) : (
        <textarea
          className="description-textarea"
          value={descriptionLocal}
          onChange={(event) => editLocal(event.target.value)}
          placeholder={t("describe.placeholderLocal")}
          lang={language}
          rows={8}
        />
      )}

      {!sameLanguage && (
        <p className={`body-s description-sync description-sync-${status}`} aria-live="polite">
          {status === "syncing" && t("describe.syncing")}
          {status === "failed" && t("describe.syncFailed")}
          {status === "idle" && t("describe.syncHint")}
        </p>
      )}

      <Button variant="primary" disabled={!canContinue || status === "syncing"} onClick={onContinue}>
        {t("describe.continue")}
      </Button>
    </div>
  );
}

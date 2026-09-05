import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { useAddProductDraft } from "../../context/AddProductDraftContext";
import { useLanguage } from "../../context/LanguageContext";
import { WEIGHT_CATEGORIES } from "../../../shared/shippingRateCard";
import "./VoiceDescribe.css";

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HeritageDetailsScreen() {
  const navigate = useNavigate();
  const { draft, updateDraft } = useAddProductDraft();
  const { t } = useLanguage();

  const [technique, setTechnique] = useState(draft.technique ?? "");
  const [timeTaken, setTimeTaken] = useState(draft.timeTaken ?? "");
  const [giTag, setGiTag] = useState(draft.giTag ?? "");
  const [careInstructions, setCareInstructions] = useState(draft.careInstructions ?? "");
  const [weightKg, setWeightKg] = useState(draft.weightKg !== undefined ? String(draft.weightKg) : "");

  const hasPhoto = Boolean(draft.imageUrl);

  useEffect(() => {
    if (!hasPhoto) {
      navigate("/add-product/photo", { replace: true });
    }
  }, [hasPhoto, navigate]);

  if (!hasPhoto) return null;

  function handleContinue() {
    const parsedWeight = Number(weightKg);
    updateDraft({
      technique: technique.trim() || undefined,
      timeTaken: timeTaken.trim() || undefined,
      giTag: giTag.trim() || undefined,
      careInstructions: careInstructions.trim() || undefined,
      weightKg: weightKg.trim() && Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : undefined,
    });
    navigate("/add-product/price");
  }

  return (
    <div className="describe-screen">
      <h1>{t("heritage.title")}</h1>
      <p className="body-s onboarding-helper heritage-subtitle">{t("heritage.subtitle")}</p>

      <div className="heritage-fields">
        <Input
          label={t("heritage.techniqueLabel")}
          value={technique}
          onChange={(event) => setTechnique(event.target.value)}
          placeholder={t("heritage.techniquePlaceholder")}
          maxLength={120}
        />
        <Input
          label={t("heritage.timeTakenLabel")}
          value={timeTaken}
          onChange={(event) => setTimeTaken(event.target.value)}
          placeholder={t("heritage.timeTakenPlaceholder")}
          maxLength={60}
        />
        <Input
          label={t("heritage.giTagLabel")}
          value={giTag}
          onChange={(event) => setGiTag(event.target.value)}
          placeholder={t("heritage.giTagPlaceholder")}
          maxLength={120}
        />
        <label className="field">
          <span className="field-label">{t("heritage.careLabel")}</span>
          <textarea
            className="description-textarea heritage-care-textarea"
            rows={3}
            value={careInstructions}
            onChange={(event) => setCareInstructions(event.target.value)}
            placeholder={t("heritage.carePlaceholder")}
            maxLength={500}
          />
        </label>

        <p className="field-label">{t("heritage.weightLabel")}</p>
        <p className="body-s onboarding-helper">{t("heritage.weightHelper")}</p>
        <div className="weight-category-grid">
          {WEIGHT_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`weight-category-button${Number(weightKg) === category.weightKg ? " weight-category-button-active" : ""}`}
              onClick={() => setWeightKg(String(category.weightKg))}
            >
              {t(category.labelKey)}
            </button>
          ))}
        </div>
        <Input
          label={t("heritage.weightExactLabel")}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          placeholder={t("heritage.weightExactPlaceholder")}
          value={weightKg}
          onChange={(event) => setWeightKg(event.target.value)}
        />
      </div>

      <Button variant="primary" icon={<ArrowIcon />} onClick={handleContinue}>
        {t("heritage.continue")}
      </Button>
    </div>
  );
}

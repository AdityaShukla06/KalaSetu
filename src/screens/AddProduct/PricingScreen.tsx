import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { suggestPrice, createProduct, getMyProfile } from "../../services/api";
import type { PricingSuggestionOutput } from "../../services/api";
import { useAddProductDraft } from "../../context/AddProductDraftContext";
import { useLanguage } from "../../context/LanguageContext";
import { translations } from "../../context/translations";
import { CATEGORIES } from "./CategoryStep";
import { estimateShippingByZone } from "../../../shared/shippingEstimator";
import { SHIPPING_ZONES } from "../../../shared/shippingRateCard";
import "./Pricing.css";

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PublishIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 5 5 9-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getCategoryTitles(categoryId: string, language: string): { en: string; local: string } {
  const entry = CATEGORIES.find((category) => category.id === categoryId);
  const key = entry?.labelKey ?? "category.other";
  return {
    en: translations.en?.[key] ?? categoryId,
    local: translations[language]?.[key] ?? translations.en?.[key] ?? categoryId,
  };
}

type Suggestion = PricingSuggestionOutput;

export function PricingScreen() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const { draft, resetDraft } = useAddProductDraft();

  const summaryDescription =
    language === "en"
      ? draft.descriptionEn || draft.descriptionLocal
      : draft.descriptionLocal || draft.descriptionEn;

  const [materialCost, setMaterialCost] = useState("");
  const [materialCostError, setMaterialCostError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestedForCost, setSuggestedForCost] = useState<number | null>(null);
  const [sellingPrice, setSellingPrice] = useState("");
  const [sellingPriceEdited, setSellingPriceEdited] = useState(false);
  const [sellingPriceError, setSellingPriceError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(false);
  const [published, setPublished] = useState(false);
  const [passportId, setPassportId] = useState<string | null>(null);
  const [artisanPincode, setArtisanPincode] = useState<string | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((profile) => setArtisanPincode(profile.pincode))
      .catch(() => setArtisanPincode(null));
  }, []);

  const hasDescription = Boolean(draft.descriptionEn?.trim() || draft.descriptionLocal?.trim());
  const missingPhoto = !draft.imageUrl;
  const missingDescription = !missingPhoto && !(draft.category && hasDescription);
  const hasRequiredDraft = !missingPhoto && !missingDescription;

  useEffect(() => {
    if (published) return;
    if (missingPhoto) {
      navigate("/add-product/photo", { replace: true });
    } else if (missingDescription) {
      navigate("/add-product/describe", { replace: true });
    }
  }, [missingPhoto, missingDescription, published, navigate]);

  const parsedCost = Number(materialCost);
  const costIsValid = Boolean(materialCost.trim()) && Number.isFinite(parsedCost) && parsedCost > 0;
  const suggestionIsStale = suggestion !== null && costIsValid && parsedCost !== suggestedForCost;

  const parsedSellingPrice = Number(sellingPrice);
  const isPricedAboveRange =
    suggestion !== null &&
    typeof suggestion.overchargeCeiling === "number" &&
    Number.isFinite(parsedSellingPrice) &&
    parsedSellingPrice > suggestion.overchargeCeiling;

  const fetchSuggestion = useCallback(
    async (cost: number) => {
      setSuggestError(false);
      setSuggesting(true);

      try {
        const result = await suggestPrice({
          category: draft.category ?? "other",
          materialCost: cost,
          descriptionEn: draft.descriptionEn ?? "",
          imageUrl: draft.imageUrl ?? "",
        });
        setSuggestion(result);
        setSuggestedForCost(cost);
        if (!sellingPriceEdited) {
          setSellingPrice(String(Math.round((result.suggestedMin + result.suggestedMax) / 2)));
        }
      } catch {
        setSuggestError(true);
      } finally {
        setSuggesting(false);
      }
    },
    [draft.category, draft.descriptionEn, draft.imageUrl, sellingPriceEdited],
  );

  async function handleGetSuggestion() {
    if (!costIsValid) {
      setMaterialCostError(t("pricing.materialCostInvalid"));
      return;
    }
    setMaterialCostError(null);
    await fetchSuggestion(parsedCost);
  }

  useEffect(() => {
    if (!suggestionIsStale) return;
    const timer = setTimeout(() => {
      void fetchSuggestion(parsedCost);
    }, 600);
    return () => clearTimeout(timer);
  }, [suggestionIsStale, parsedCost, fetchSuggestion]);

  async function handlePublish() {
    const price = Number(sellingPrice);
    if (!sellingPrice.trim() || !Number.isFinite(price) || price <= 0) {
      setSellingPriceError(t("pricing.sellingPriceInvalid"));
      return;
    }

    const cost = Number(materialCost);
    if (!materialCost.trim() || !Number.isFinite(cost) || cost <= 0) {
      setMaterialCostError(t("pricing.materialCostInvalid"));
      return;
    }

    setSellingPriceError(null);
    setPublishError(false);
    setPublishing(true);

    const titles = getCategoryTitles(draft.category ?? "other", language);
    const en = draft.descriptionEn?.trim() || draft.descriptionLocal?.trim() || "";
    const local = draft.descriptionLocal?.trim() || draft.descriptionEn?.trim() || "";

    try {
      const result = await createProduct({
        category: draft.category ?? "other",
        material: draft.material,
        titleEn: titles.en,
        titleLocal: titles.local,
        descriptionEn: en,
        descriptionLocal: local,
        localLanguage: language,
        imageUrl: draft.imageUrl ?? "",
        price,
        materialCost: cost,
        technique: draft.technique,
        timeTaken: draft.timeTaken,
        giTag: draft.giTag,
        careInstructions: draft.careInstructions,
        weightKg: draft.weightKg,
      });
      setPassportId(result.passportId);
      resetDraft();
      setPublished(true);
    } catch {
      setPublishError(true);
    } finally {
      setPublishing(false);
    }
  }

  if (published) {
    return (
      <div className="pricing-success">
        <span className="pricing-success-icon">
          <CheckCircleIcon />
        </span>
        <h1>{t("pricing.successTitle")}</h1>
        <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
          {t("pricing.successMessage")}
        </p>
        <Button variant="primary" icon={<ArrowIcon />} onClick={() => navigate("/")}>
          {t("pricing.viewShop")}
        </Button>
        {passportId && (
          <a
            href={`/passport/${passportId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="pricing-passport-link"
          >
            {t("passport.viewLink")}
          </a>
        )}
      </div>
    );
  }

  if (!hasRequiredDraft) return null;

  return (
    <div className="pricing-screen">
      <h1>{t("pricing.title")}</h1>

      <div className="pricing-summary">
        {draft.imageUrl && <img src={draft.imageUrl} alt="" className="pricing-summary-thumb" />}
        <div className="pricing-summary-text">
          <p className="body-s pricing-summary-description">{summaryDescription}</p>
          <button
            type="button"
            className="pricing-summary-edit"
            onClick={() => navigate("/add-product/describe")}
          >
            {t("pricing.summaryEdit")}
          </button>
        </div>
      </div>

      <div className="pricing-section">
        <Input
          label={t("pricing.materialCostLabel")}
          prefix="₹"
          type="number"
          inputMode="decimal"
          min="0"
          value={materialCost}
          onChange={(event) => {
            setMaterialCost(event.target.value);
            if (materialCostError) setMaterialCostError(null);
            if (!event.target.value.trim()) {
              setSuggestion(null);
              setSuggestedForCost(null);
            }
          }}
          error={materialCostError ?? undefined}
        />
        <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
          {t("pricing.materialCostHelper")}
        </p>

        {!suggestion && (
          <Button variant="primary" icon={<ArrowIcon />} loading={suggesting} onClick={handleGetSuggestion}>
            {t("pricing.getSuggestion")}
          </Button>
        )}

        {suggestError && (
          <>
            <p className="pricing-error" role="alert">
              {t("pricing.suggestError")}
            </p>
            <Button variant="primary" icon={<RetryIcon />} onClick={handleGetSuggestion}>
              {t("pricing.retry")}
            </Button>
          </>
        )}
      </div>

      {suggestion && (
        <div className="pricing-section">
          <p className="caption">{t("pricing.rangeLabel")}</p>
          <div className={`pricing-range${suggesting ? " pricing-range-stale" : ""}`}>
            <span className="pricing-range-value">
              ₹{suggestion.suggestedMin} - ₹{suggestion.suggestedMax}
            </span>
            {suggesting && <p className="body-s pricing-updating">{t("pricing.updating")}</p>}
            <p className="body-s pricing-reasoning">{suggestion.reasoning}</p>
          </div>

          {suggestion.materialCostAssessment?.status === "above_typical_range" && (
            <p className="pricing-material-cost-note" role="status">
              {t("pricing.materialCostAboveTypical", {
                category: suggestion.pricingBreakdown?.categoryName ?? draft.category ?? "",
                min: suggestion.materialCostAssessment.typicalMin ?? 0,
                max: suggestion.materialCostAssessment.typicalMax ?? 0,
              })}
              {suggestion.materialCostAssessment.wasCapped &&
                ` ${t("pricing.materialCostCappedNote", {
                  cappedCost: suggestion.materialCostAssessment.materialCostUsedForCalculation,
                })}`}
            </p>
          )}
          {suggestion.materialCostAssessment?.status === "below_typical_range" && (
            <p className="pricing-material-cost-note" role="status">
              {t("pricing.materialCostBelowTypical", {
                category: suggestion.pricingBreakdown?.categoryName ?? draft.category ?? "",
                min: suggestion.materialCostAssessment.typicalMin ?? 0,
                max: suggestion.materialCostAssessment.typicalMax ?? 0,
              })}
            </p>
          )}

          {suggestion.pricingBreakdown && (
            <details className="pricing-breakdown">
              <summary>{t("pricing.breakdownToggle")}</summary>
              <ul className="pricing-breakdown-list">
                <li>
                  <span>{t("pricing.materialCostLabel")}</span>
                  <span>₹{suggestion.pricingBreakdown.materialCostUsedForCalculation}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownLabour")}</span>
                  <span>₹{suggestion.pricingBreakdown.estimatedLabourCost}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownOverhead")}</span>
                  <span>₹{suggestion.pricingBreakdown.overhead}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownProductionCost")}</span>
                  <span>₹{suggestion.pricingBreakdown.productionCost}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownMargin")}</span>
                  <span>₹{suggestion.pricingBreakdown.fairPriceFloor}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownComplexity")}</span>
                  <span>{suggestion.pricingBreakdown.complexity}</span>
                </li>
                <li>
                  <span>{t("pricing.breakdownCategory")}</span>
                  <span>{suggestion.pricingBreakdown.categoryName}</span>
                </li>
              </ul>
              <p className="body-s pricing-breakdown-disclaimer">{t("pricing.breakdownDisclaimer")}</p>
            </details>
          )}

          <Input
            label={t("pricing.sellingPriceLabel")}
            prefix="₹"
            type="number"
            inputMode="decimal"
            min="0"
            value={sellingPrice}
            onChange={(event) => {
              setSellingPrice(event.target.value);
              setSellingPriceEdited(true);
              if (sellingPriceError) setSellingPriceError(null);
            }}
            error={sellingPriceError ?? undefined}
          />
          <p className="body-s pricing-note">{t("pricing.sellingPriceNote")}</p>

          {isPricedAboveRange && (
            <p className="pricing-overcharge-banner" role="status">
              <strong>{t("pricing.overchargeBannerTitle")}</strong>
              <br />
              {t("pricing.overchargeBannerBody", {
                min: suggestion.minimumPrice ?? suggestion.suggestedMin,
                max: suggestion.maximumPrice ?? suggestion.suggestedMax,
              })}
            </p>
          )}

          {draft.weightKg ? (
            <details className="pricing-breakdown">
              <summary>{t("shipping.estimateToggle")}</summary>
              <p className="body-s pricing-breakdown-disclaimer">{t("shipping.estimateDisclaimer")}</p>
              <ul className="pricing-breakdown-list">
                {SHIPPING_ZONES.map((zone) => {
                  const range = estimateShippingByZone(draft.weightKg as number)?.[zone];
                  if (!range) return null;
                  return (
                    <li key={zone}>
                      <span>{t(`shipping.zone.${zone}`)}</span>
                      <span>
                        ₹{range.minCost}–₹{range.maxCost}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {!artisanPincode && <p className="body-s pricing-breakdown-disclaimer">{t("shipping.pincodeMissingArtisanNote")}</p>}
            </details>
          ) : (
            <p className="caption pricing-note">{t("shipping.weightMissingArtisanNote")}</p>
          )}

          <Button variant="primary" icon={<PublishIcon />} loading={publishing} onClick={handlePublish}>
            {t("pricing.publish")}
          </Button>

          {publishError && (
            <>
              <p className="pricing-error" role="alert">
                {t("pricing.publishError")}
              </p>
              <Button variant="primary" icon={<RetryIcon />} onClick={handlePublish}>
                {t("pricing.retry")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

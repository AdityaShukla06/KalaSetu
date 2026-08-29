import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { suggestPrice, createProduct } from "../../services/api";
import { useAddProductDraft } from "../../context/AddProductDraftContext";
import { useLanguage } from "../../context/LanguageContext";
import { translations } from "../../context/translations";
import { CATEGORIES } from "./CategoryStep";
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

function getCategoryTitles(categoryId: string): { en: string; hi: string } {
  const entry = CATEGORIES.find((category) => category.id === categoryId);
  const key = entry?.labelKey ?? "category.other";
  return {
    en: translations.en[key] ?? categoryId,
    hi: translations.hi[key] ?? categoryId,
  };
}

interface Suggestion {
  suggestedMin: number;
  suggestedMax: number;
  reasoning: string;
}

export function PricingScreen() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const { draft, resetDraft } = useAddProductDraft();

  const summaryDescription =
    language === "hi"
      ? draft.descriptionHi || draft.descriptionEn
      : draft.descriptionEn || draft.descriptionHi;

  const [materialCost, setMaterialCost] = useState("");
  const [materialCostError, setMaterialCostError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [sellingPrice, setSellingPrice] = useState("");
  const [sellingPriceError, setSellingPriceError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(false);
  const [published, setPublished] = useState(false);

  const hasDescription = Boolean(draft.descriptionEn?.trim() || draft.descriptionHi?.trim());
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

  async function handleGetSuggestion() {
    const cost = Number(materialCost);
    if (!materialCost.trim() || !Number.isFinite(cost) || cost <= 0) {
      setMaterialCostError(t("pricing.materialCostInvalid"));
      return;
    }

    setMaterialCostError(null);
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
      setSellingPrice(String(Math.round((result.suggestedMin + result.suggestedMax) / 2)));
    } catch {
      setSuggestError(true);
    } finally {
      setSuggesting(false);
    }
  }

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

    const titles = getCategoryTitles(draft.category ?? "other");
    const en = draft.descriptionEn?.trim() || draft.descriptionHi?.trim() || "";
    const hi = draft.descriptionHi?.trim() || draft.descriptionEn?.trim() || "";

    try {
      await createProduct({
        category: draft.category ?? "other",
        titleEn: titles.en,
        titleHi: titles.hi,
        descriptionEn: en,
        descriptionHi: hi,
        imageUrl: draft.imageUrl ?? "",
        price,
        materialCost: cost,
      });
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
          <div className="pricing-range">
            <span className="pricing-range-value">
              ₹{suggestion.suggestedMin} - ₹{suggestion.suggestedMax}
            </span>
            <p className="body-s pricing-reasoning">{suggestion.reasoning}</p>
          </div>

          <Input
            label={t("pricing.sellingPriceLabel")}
            prefix="₹"
            type="number"
            inputMode="decimal"
            min="0"
            value={sellingPrice}
            onChange={(event) => {
              setSellingPrice(event.target.value);
              if (sellingPriceError) setSellingPriceError(null);
            }}
            error={sellingPriceError ?? undefined}
          />
          <p className="body-s pricing-note">{t("pricing.sellingPriceNote")}</p>

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

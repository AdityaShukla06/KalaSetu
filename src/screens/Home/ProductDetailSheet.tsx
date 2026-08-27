import { useState } from "react";
import { Button } from "../../components/Button";
import type { Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import "./Home.css";

interface ProductDetailSheetProps {
  product: Product;
  onClose: () => void;
}

type DescriptionTab = "en" | "hi";

function CloseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4l10-10-4-4L4 16v4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProductDetailSheet({ product, onClose }: ProductDetailSheetProps) {
  const { language, t } = useLanguage();
  const [descriptionTab, setDescriptionTab] = useState<DescriptionTab>(language);

  const title = language === "hi" ? product.titleHi : product.titleEn;
  const categoryEntry = CATEGORIES.find((category) => category.id === product.category);
  const categoryLabel = categoryEntry ? t(categoryEntry.labelKey) : product.category;
  const description = descriptionTab === "hi" ? product.descriptionHi : product.descriptionEn;

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="sheet-close" onClick={onClose} aria-label={t("home.detailClose")}>
          <CloseIcon />
        </button>

        <img src={product.imageUrl} alt="" className="sheet-photo" />

        <div className="sheet-body">
          <h2>{title}</h2>
          <p className="price">₹{product.price}</p>
          <p className="caption">
            {t("home.detailCategory")}: {categoryLabel}
          </p>

          <div className="language-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={descriptionTab === "en"}
              className={`language-option${descriptionTab === "en" ? " language-option-active" : ""}`}
              onClick={() => setDescriptionTab("en")}
            >
              {t("language.en")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={descriptionTab === "hi"}
              className={`language-option${descriptionTab === "hi" ? " language-option-active" : ""}`}
              onClick={() => setDescriptionTab("hi")}
            >
              {t("language.hi")}
            </button>
          </div>

          <p className="body-s sheet-description">{description}</p>

          <div className="sheet-actions">
            <Button
              variant="secondary"
              icon={<EditIcon />}
              onClick={() => console.info("edit product", product.productId)}
            >
              {t("home.detailEdit")}
            </Button>
            <Button
              variant="destructive"
              icon={<DeleteIcon />}
              onClick={() => console.info("delete product", product.productId)}
            >
              {t("home.detailDelete")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

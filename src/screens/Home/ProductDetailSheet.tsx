import { useState } from "react";
import { Button } from "../../components/Button";
import { deleteProduct, updateProduct, type Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import "./Home.css";

interface ProductDetailSheetProps {
  product: Product;
  onClose: () => void;
  onChanged: () => void;
}

type DescriptionTab = "en" | "hi";
type Mode = "view" | "edit" | "confirmDelete";

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

function SaveIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 5 5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ProductDetailSheet({ product, onClose, onChanged }: ProductDetailSheetProps) {
  const { language, t } = useLanguage();
  const [descriptionTab, setDescriptionTab] = useState<DescriptionTab>(language);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [price, setPrice] = useState(String(product.price));
  const [descriptionEn, setDescriptionEn] = useState(product.descriptionEn);
  const [descriptionHi, setDescriptionHi] = useState(product.descriptionHi);

  const title = language === "hi" ? product.titleHi : product.titleEn;
  const categoryEntry = CATEGORIES.find((category) => category.id === product.category);
  const categoryLabel = categoryEntry ? t(categoryEntry.labelKey) : product.category;
  const description = descriptionTab === "hi" ? product.descriptionHi : product.descriptionEn;

  function startEdit() {
    setPrice(String(product.price));
    setDescriptionEn(product.descriptionEn);
    setDescriptionHi(product.descriptionHi);
    setError(null);
    setMode("edit");
  }

  async function handleSave() {
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setError(t("home.editPriceInvalid"));
      return;
    }
    if (!descriptionEn.trim() || !descriptionHi.trim()) {
      setError(t("home.editDescriptionRequired"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await updateProduct(product.productId, {
        price: parsedPrice,
        descriptionEn: descriptionEn.trim(),
        descriptionHi: descriptionHi.trim(),
      });
      onChanged();
      onClose();
    } catch {
      setError(t("home.editError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteProduct(product.productId);
      onChanged();
      onClose();
    } catch {
      setError(t("home.deleteError"));
      setMode("view");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={busy ? undefined : onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sheet-close"
          onClick={onClose}
          disabled={busy}
          aria-label={t("home.detailClose")}
        >
          <CloseIcon />
        </button>

        <img src={product.imageUrl} alt="" className="sheet-photo" />

        <div className="sheet-body">
          <h2>{title}</h2>

          {mode === "edit" ? (
            <label className="sheet-field">
              <span className="caption">{t("home.editPriceLabel")}</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                disabled={busy}
              />
            </label>
          ) : (
            <p className="price">₹{product.price}</p>
          )}

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

          {mode === "edit" ? (
            <label className="sheet-field">
              <span className="caption">{t("home.editDescriptionLabel")}</span>
              <textarea
                rows={4}
                value={descriptionTab === "hi" ? descriptionHi : descriptionEn}
                onChange={(event) =>
                  descriptionTab === "hi"
                    ? setDescriptionHi(event.target.value)
                    : setDescriptionEn(event.target.value)
                }
                disabled={busy}
              />
            </label>
          ) : (
            <p className="body-s sheet-description">{description}</p>
          )}

          {error && (
            <p className="onboarding-error" role="alert">
              {error}
            </p>
          )}

          {mode === "confirmDelete" && (
            <p className="body-s sheet-confirm">{t("home.deleteConfirm")}</p>
          )}

          <div className="sheet-actions">
            {mode === "view" && (
              <>
                <Button variant="secondary" icon={<EditIcon />} onClick={startEdit}>
                  {t("home.detailEdit")}
                </Button>
                <Button
                  variant="destructive"
                  icon={<DeleteIcon />}
                  onClick={() => setMode("confirmDelete")}
                >
                  {t("home.detailDelete")}
                </Button>
              </>
            )}

            {mode === "edit" && (
              <>
                <Button variant="primary" icon={<SaveIcon />} loading={busy} onClick={handleSave}>
                  {t("home.editSave")}
                </Button>
                <Button variant="tertiary" onClick={() => setMode("view")} disabled={busy}>
                  {t("home.editCancel")}
                </Button>
              </>
            )}

            {mode === "confirmDelete" && (
              <>
                <Button
                  variant="destructive"
                  icon={<DeleteIcon />}
                  loading={busy}
                  onClick={handleDelete}
                >
                  {t("home.deleteConfirmYes")}
                </Button>
                <Button variant="tertiary" onClick={() => setMode("view")} disabled={busy}>
                  {t("home.editCancel")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

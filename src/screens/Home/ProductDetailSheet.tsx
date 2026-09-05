import { useState } from "react";
import { Button } from "../../components/Button";
import { LanguageTabs, type DescriptionTab } from "../../components/LanguageTabs";
import { deleteProduct, updateProduct, type Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import { useMirroredDescription } from "../AddProduct/useMirroredDescription";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import "./Home.css";

interface ProductDetailSheetProps {
  product: Product;
  onClose: () => void;
  onChanged: () => void;
}

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
  const [descriptionTab, setDescriptionTab] = useState<DescriptionTab>(language === "en" ? "en" : "local");
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [price, setPrice] = useState(String(product.price));
  const [descriptionEn, setDescriptionEn] = useState(product.descriptionEn);
  const [descriptionLocal, setDescriptionLocal] = useState(product.descriptionLocal);

  const { status: syncStatus, editEn, editLocal, sameLanguage } = useMirroredDescription({
    language: product.localLanguage,
    descriptionEn,
    descriptionLocal,
    onChangeEn: setDescriptionEn,
    onChangeLocal: setDescriptionLocal,
  });

  const title = language === product.localLanguage ? product.titleLocal : product.titleEn;
  const categoryEntry = CATEGORIES.find((category) => category.id === product.category);
  const categoryLabel = categoryEntry ? t(categoryEntry.labelKey) : product.category;
  const description = descriptionTab === "local" ? product.descriptionLocal : product.descriptionEn;

  function startEdit() {
    setPrice(String(product.price));
    setDescriptionEn(product.descriptionEn);
    setDescriptionLocal(product.descriptionLocal);
    setError(null);
    setMode("edit");
  }

  async function handleSave() {
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setError(t("home.editPriceInvalid"));
      return;
    }
    if (!descriptionEn.trim() || !descriptionLocal.trim()) {
      setError(t("home.editDescriptionRequired"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await updateProduct(product.productId, {
        price: parsedPrice,
        descriptionEn: descriptionEn.trim(),
        descriptionLocal: descriptionLocal.trim(),
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

          <a
            href={`/passport/${product.passportId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="sheet-passport-link"
          >
            {t("passport.viewLink")}
          </a>

          {mode === "view" && product.autoFlagReason && (
            <p className="sheet-price-note">
              <span className="sheet-price-note-badge">{t("pricing.priceNoteBadge")}</span>
              {product.autoFlagReason}
            </p>
          )}

          <LanguageTabs value={descriptionTab} onChange={setDescriptionTab} />

          {mode === "edit" ? (
            <label className="sheet-field">
              <span className="caption">{t("home.editDescriptionLabel")}</span>
              <textarea
                rows={4}
                value={descriptionTab === "local" ? descriptionLocal : descriptionEn}
                onChange={(event) =>
                  descriptionTab === "local"
                    ? editLocal(event.target.value)
                    : editEn(event.target.value)
                }
                disabled={busy}
              />
              {!sameLanguage && syncStatus !== "idle" && (
                <span className={`caption description-sync-${syncStatus}`} aria-live="polite">
                  {syncStatus === "syncing" ? t("describe.syncing") : t("describe.syncFailed")}
                </span>
              )}
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
                <Button
                  variant="primary"
                  icon={<SaveIcon />}
                  loading={busy}
                  disabled={syncStatus === "syncing"}
                  onClick={handleSave}
                >
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

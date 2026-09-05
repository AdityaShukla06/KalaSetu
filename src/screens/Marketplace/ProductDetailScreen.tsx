import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { LanguageTabs, type DescriptionTab } from "../../components/LanguageTabs";
import { getMarketplaceProduct, createInquiry } from "../../services/api";
import type { ProductWithArtisan } from "../../services/api";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import { useLanguage } from "../../context/LanguageContext";
import "./ProductDetail.css";

type LoadState = "loading" | "error" | "not-found" | "loaded";
type InquiryState = "idle" | "sending" | "sent" | "error";

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 4 16 8-16 8 4-8-4-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
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

export function ProductDetailScreen() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const { language, t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [product, setProduct] = useState<ProductWithArtisan | null>(null);
  const [descriptionTab, setDescriptionTab] = useState<DescriptionTab>(language === "en" ? "en" : "local");

  const [message, setMessage] = useState("");
  const [inquiryState, setInquiryState] = useState<InquiryState>("idle");

  const load = useCallback(async () => {
    if (!productId) return;
    setState("loading");
    try {
      const result = await getMarketplaceProduct(productId);
      setProduct(result);
      setState("loaded");
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        setState("not-found");
      } else {
        setState("error");
      }
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSendInquiry() {
    if (!productId || !message.trim()) return;
    setInquiryState("sending");
    try {
      await createInquiry(productId, message.trim());
      setInquiryState("sent");
      setMessage("");
    } catch {
      setInquiryState("error");
    }
  }

  if (state === "loading") {
    return (
      <div className="product-detail">
        <Skeleton height="360px" borderRadius="var(--radius-card)" />
        <div className="product-detail-body">
          <Skeleton height="28px" width="70%" />
          <Skeleton height="24px" width="30%" />
          <Skeleton height="80px" />
        </div>
      </div>
    );
  }

  if (state === "not-found") {
    return (
      <div className="product-detail-state">
        <h3>{t("marketplace.detailNotFoundTitle")}</h3>
        <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
          {t("marketplace.detailNotFoundMessage")}
        </p>
        <Button variant="primary" onClick={() => navigate("/marketplace")}>
          {t("marketplace.backToBrowse")}
        </Button>
      </div>
    );
  }

  if (state === "error" || !product) {
    return (
      <div className="product-detail-state">
        <p className="body-s">{t("marketplace.loadError")}</p>
        <Button variant="primary" icon={<RetryIcon />} onClick={load}>
          {t("home.retry")}
        </Button>
      </div>
    );
  }

  const title = language === product.localLanguage ? product.titleLocal : product.titleEn;
  const categoryEntry = CATEGORIES.find((category) => category.id === product.category);
  const categoryLabel = categoryEntry ? t(categoryEntry.labelKey) : product.category;
  const description = descriptionTab === "local" ? product.descriptionLocal : product.descriptionEn;
  const artisanName = product.artisan.shopName || product.artisan.displayName || t("marketplace.artisanUnnamed");

  return (
    <div className="product-detail">
      <Link to="/marketplace" className="product-detail-back">
        <BackIcon />
        {t("marketplace.backToBrowse")}
      </Link>

      <div className="product-detail-layout">
        <div className="product-detail-gallery">
          <img src={product.imageUrl} alt="" className="product-detail-photo" />
        </div>

        <div className="product-detail-body">
          <h1>{title}</h1>
          <p className="price">₹{product.price}</p>

          <div className="product-detail-tags">
            <span className="product-detail-tag">{categoryLabel}</span>
            {product.material && <span className="product-detail-tag">{product.material}</span>}
            {product.region && (
              <span className="product-detail-tag">
                <PinIcon />
                {product.region}
              </span>
            )}
          </div>

          <a
            href={`/passport/${product.passportId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="product-detail-passport-link"
          >
            {t("passport.viewLink")}
          </a>

          <LanguageTabs value={descriptionTab} onChange={setDescriptionTab} />
          <p className="body-s product-detail-description">{description}</p>

          <div className="artisan-card">
            <h3>{t("marketplace.artisanSummaryTitle")}</h3>
            <p className="product-detail-artisan-name">{artisanName}</p>
            {product.artisan.region && (
              <p className="caption product-detail-artisan-meta">
                <PinIcon />
                {product.artisan.region}
              </p>
            )}
            <p className="caption product-detail-artisan-meta">
              {t("marketplace.artisanProductCount", { n: product.artisan.totalProducts })}
            </p>
          </div>

          <div className="inquiry-card">
            <h3>{t("marketplace.inquiryTitle")}</h3>

            {inquiryState === "sent" ? (
              <p className="body-s inquiry-sent">{t("marketplace.inquirySent")}</p>
            ) : (
              <>
                <label className="visually-hidden" htmlFor="inquiry-message">
                  {t("marketplace.inquiryPlaceholder")}
                </label>
                <textarea
                  id="inquiry-message"
                  className="inquiry-textarea"
                  rows={4}
                  placeholder={t("marketplace.inquiryPlaceholder")}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    if (inquiryState === "error") setInquiryState("idle");
                  }}
                  disabled={inquiryState === "sending"}
                />
                {inquiryState === "error" && (
                  <p className="onboarding-error" role="alert">
                    {t("marketplace.inquiryError")}
                  </p>
                )}
                <Button
                  variant="primary"
                  icon={<SendIcon />}
                  loading={inquiryState === "sending"}
                  disabled={!message.trim()}
                  onClick={handleSendInquiry}
                >
                  {t("marketplace.inquirySend")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

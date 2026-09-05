import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { LanguageTabs, type DescriptionTab } from "../../components/LanguageTabs";
import { getMarketplaceProduct, createInquiry, recordProductView } from "../../services/api";
import type { ProductWithArtisan, InquiryContactPreference } from "../../services/api";
import { buildWhatsAppUrl } from "../../../shared/whatsapp";
import { estimateShippingCost, isValidIndianPincode } from "../../../shared/shippingEstimator";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import { useLanguage } from "../../context/LanguageContext";
import "./ProductDetail.css";

type LoadState = "loading" | "error" | "not-found" | "loaded";
type InquiryState = "idle" | "sending" | "sent" | "error";

const VIEWED_SESSION_KEY = "kalasetu:viewedProducts";
const DESTINATION_PINCODE_KEY = "kalasetu:destinationPincode";

function hasRecordedView(productId: string): boolean {
  try {
    const raw = sessionStorage.getItem(VIEWED_SESSION_KEY);
    const viewed: string[] = raw ? JSON.parse(raw) : [];
    return viewed.includes(productId);
  } catch {
    return false;
  }
}

function markViewRecorded(productId: string): void {
  try {
    const raw = sessionStorage.getItem(VIEWED_SESSION_KEY);
    const viewed: string[] = raw ? JSON.parse(raw) : [];
    if (!viewed.includes(productId)) {
      viewed.push(productId);
      sessionStorage.setItem(VIEWED_SESSION_KEY, JSON.stringify(viewed));
    }
  } catch {
    return;
  }
}

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

function WhatsAppIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20l1.4-4.1A7.9 7.9 0 1 1 8.4 19L4 20Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 8.6c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .5.4.2.5.6 1.5.6 1.6.1.1.1.3 0 .4-.1.2-.1.3-.3.5-.1.2-.3.3-.4.5-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1.2-.2.7-.8.9-1.1.2-.2.4-.2.6-.1.2.1 1.5.7 1.8.8.3.1.4.2.5.3.1.2.1.9-.2 1.4-.3.5-1.5 1.1-2.1 1.1-.6 0-1.1.1-3.7-1.1-2.6-1.2-4.2-3.7-4.4-3.9-.1-.2-1-1.3-1-2.5s.6-1.8.8-2Z"
        fill="currentColor"
      />
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
  const [quantity, setQuantity] = useState("");
  const [contactPreference, setContactPreference] = useState<InquiryContactPreference>("email");
  const [contactValue, setContactValue] = useState("");
  const [inquiryState, setInquiryState] = useState<InquiryState>("idle");

  const [destinationPincode, setDestinationPincode] = useState(() => {
    try {
      return sessionStorage.getItem(DESTINATION_PINCODE_KEY) ?? "";
    } catch {
      return "";
    }
  });

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

  useEffect(() => {
    if (state !== "loaded" || !productId || hasRecordedView(productId)) return;
    markViewRecorded(productId);
    recordProductView(productId).catch(() => {});
  }, [state, productId]);

  const needsContactValue = contactPreference !== "email";
  const contactValueMissing = needsContactValue && !contactValue.trim();

  async function handleSendInquiry() {
    if (!productId || !message.trim() || contactValueMissing) return;
    setInquiryState("sending");
    try {
      const parsedQuantity = Number(quantity);
      await createInquiry({
        productId,
        message: message.trim(),
        quantity: quantity.trim() && Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : undefined,
        contactPreference,
        contactValue: needsContactValue ? contactValue.trim() : undefined,
      });
      setInquiryState("sent");
      setMessage("");
      setQuantity("");
      setContactValue("");
    } catch {
      setInquiryState("error");
    }
  }

  function handleDestinationPincodeChange(value: string) {
    setDestinationPincode(value);
    try {
      if (isValidIndianPincode(value)) sessionStorage.setItem(DESTINATION_PINCODE_KEY, value.trim());
    } catch {
      return;
    }
  }

  function handleWhatsAppHandoff() {
    if (!product?.artisan.whatsappNumber) return;
    const text = t("marketplace.whatsappPrefill", { product: title, passportId: product.passportId });
    window.open(buildWhatsAppUrl(product.artisan.whatsappNumber, text), "_blank", "noopener,noreferrer");
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

  const shippingUnavailable = !product.weightKg || !product.artisan.pincode;
  const shippingEstimate =
    !shippingUnavailable && isValidIndianPincode(destinationPincode)
      ? estimateShippingCost(product.weightKg as number, product.artisan.pincode as string, destinationPincode)
      : null;

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

          {shippingUnavailable ? (
            <p className="caption shipping-estimate-unavailable">{t("shipping.buyerUnavailable")}</p>
          ) : (
            <div className="shipping-estimate-card">
              <Input
                label={t("shipping.pincodeLabel")}
                type="tel"
                inputMode="numeric"
                maxLength={6}
                placeholder={t("shipping.pincodePlaceholder")}
                value={destinationPincode}
                onChange={(event) => handleDestinationPincodeChange(event.target.value)}
              />
              {destinationPincode && !isValidIndianPincode(destinationPincode) && (
                <p className="caption shipping-estimate-error">{t("shipping.pincodeInvalid")}</p>
              )}
              {shippingEstimate && (
                <div className="shipping-estimate-result">
                  <p className="body-s shipping-estimate-line">
                    <span className="shipping-estimate-label">{t("shipping.estimatedShippingLabel")}</span>
                    <span>
                      ₹{shippingEstimate.minCost}–₹{shippingEstimate.maxCost}
                    </span>
                  </p>
                  <p className="body-s shipping-estimate-line shipping-estimate-total">
                    <span className="shipping-estimate-label">{t("shipping.estimatedTotalLabel")}</span>
                    <span>
                      ₹{product.price + shippingEstimate.minCost}–₹{product.price + shippingEstimate.maxCost}
                    </span>
                  </p>
                  <p className="caption shipping-estimate-disclaimer">{t("shipping.buyerDisclaimer")}</p>
                </div>
              )}
            </div>
          )}

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

          {product.autoFlagReason && (
            <p className="product-detail-price-note">
              <span className="product-detail-price-note-badge">{t("pricing.priceNoteBadge")}</span>
              {product.autoFlagReason}
            </p>
          )}

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

          {product.artisan.whatsappNumber && (
            <button type="button" className="whatsapp-handoff-button" onClick={handleWhatsAppHandoff}>
              <WhatsAppIcon />
              {t("marketplace.whatsappButton")}
            </button>
          )}

          <div className="inquiry-card">
            <h3>{t("marketplace.inquiryTitle")}</h3>
            <p className="caption inquiry-card-subtitle">{t("marketplace.inquirySubtitle")}</p>

            {inquiryState === "sent" ? (
              <p className="body-s inquiry-sent">{t("marketplace.inquirySent")}</p>
            ) : (
              <>
                <Input
                  label={t("marketplace.inquiryQuantityLabel")}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  placeholder={t("marketplace.inquiryQuantityPlaceholder")}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  disabled={inquiryState === "sending"}
                />

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

                <p className="field-label">{t("marketplace.contactPreferenceLabel")}</p>
                <div className="contact-pref-tabs" role="tablist">
                  {(["email", "phone", "whatsapp"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="tab"
                      aria-selected={contactPreference === option}
                      className={`contact-pref-tab${contactPreference === option ? " contact-pref-tab-active" : ""}`}
                      onClick={() => setContactPreference(option)}
                      disabled={inquiryState === "sending"}
                    >
                      {t(`marketplace.contactPreference.${option}`)}
                    </button>
                  ))}
                </div>

                {needsContactValue && (
                  <Input
                    label={t("marketplace.contactValueLabel")}
                    type="tel"
                    placeholder={t("marketplace.contactValuePlaceholder")}
                    value={contactValue}
                    onChange={(event) => setContactValue(event.target.value)}
                    disabled={inquiryState === "sending"}
                  />
                )}

                {inquiryState === "error" && (
                  <p className="onboarding-error" role="alert">
                    {t("marketplace.inquiryError")}
                  </p>
                )}
                <Button
                  variant="primary"
                  icon={<SendIcon />}
                  loading={inquiryState === "sending"}
                  disabled={!message.trim() || contactValueMissing}
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

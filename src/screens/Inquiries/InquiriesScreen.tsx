import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { InquiryThread } from "../../components/InquiryThread";
import { listReceivedInquiries, closeInquiry } from "../../services/api";
import type { Inquiry, InquiryMessage } from "../../services/api";
import { buildWhatsAppUrl } from "../../../shared/whatsapp";
import { useLanguage } from "../../context/LanguageContext";
import "./Inquiries.css";

type LoadState = "loading" | "error" | "loaded";

const CONTACT_LABEL_KEY: Record<Inquiry["contactPreference"], string> = {
  email: "marketplace.contactPreference.email",
  phone: "marketplace.contactPreference.phone",
  whatsapp: "marketplace.contactPreference.whatsapp",
};

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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

function WhatsAppIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20l1.4-4.1A7.9 7.9 0 1 1 8.4 19L4 20Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function InquiriesScreen() {
  const { t } = useLanguage();
  const [state, setState] = useState<LoadState>("loading");
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await listReceivedInquiries();
      setInquiries(result);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleClose(inquiryId: string) {
    setBusyId(inquiryId);
    try {
      await closeInquiry(inquiryId);
      setInquiries((prev) =>
        prev.map((item) => (item.inquiryId === inquiryId ? { ...item, status: "closed" } : item)),
      );
    } finally {
      setBusyId(null);
    }
  }

  function handleMessageSent(inquiryId: string, message: InquiryMessage) {
    setInquiries((prev) =>
      prev.map((item) =>
        item.inquiryId === inquiryId ? { ...item, messages: [...item.messages, message] } : item,
      ),
    );
  }

  return (
    <div className="screen inquiries-screen">
      <Link to="/" className="inquiries-back">
        <BackIcon />
        {t("analytics.backToShop")}
      </Link>

      <h1>{t("inquiries.title")}</h1>

      {state === "loading" && (
        <div className="inquiries-list">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} height="120px" borderRadius="var(--radius-card)" />
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="inquiries-state">
          <p className="body-s">{t("inquiries.loadError")}</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            {t("pricing.retry")}
          </Button>
        </div>
      )}

      {state === "loaded" && inquiries.length === 0 && (
        <div className="inquiries-state">
          <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
            {t("inquiries.empty")}
          </p>
        </div>
      )}

      {state === "loaded" && inquiries.length > 0 && (
        <ul className="inquiries-list">
          {inquiries.map((inquiry) => {
            const title = inquiry.product?.titleEn ?? t("marketplace.inquiryProductRemoved");
            const whatsappTarget =
              inquiry.contactPreference !== "email" && inquiry.contactValue ? inquiry.contactValue : null;

            return (
              <li key={inquiry.inquiryId} className="inquiries-item">
                {inquiry.product && <img src={inquiry.product.imageUrl} alt="" className="inquiries-item-photo" />}
                <div className="inquiries-item-body">
                  <div className="inquiries-item-header">
                    <p className="inquiries-item-title">{title}</p>
                    {inquiry.isUnread && (
                      <span className="inquiries-badge inquiries-badge-new">{t("inquiries.badgeNew")}</span>
                    )}
                  </div>
                  {inquiry.product && (
                    <p className="caption inquiries-item-passport">{inquiry.product.passportId}</p>
                  )}
                  {inquiry.quantity && (
                    <p className="caption inquiries-item-meta">
                      {t("inquiries.quantityLine", { n: inquiry.quantity })}
                    </p>
                  )}
                  <p className="caption inquiries-item-meta">
                    {t("inquiries.contactLine", {
                      preference: t(CONTACT_LABEL_KEY[inquiry.contactPreference]),
                      value: inquiry.contactValue ?? inquiry.buyerEmail ?? "",
                    })}
                  </p>

                  <InquiryThread
                    inquiry={inquiry}
                    viewerRole="artisan"
                    onSent={(message) => handleMessageSent(inquiry.inquiryId, message)}
                  />

                  <div className="inquiries-item-actions">
                    {whatsappTarget && (
                      <a
                        href={buildWhatsAppUrl(whatsappTarget, t("inquiries.whatsappReplyPrefill", { product: title }))}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inquiries-whatsapp-link"
                      >
                        <WhatsAppIcon />
                        {t("inquiries.replyOnWhatsapp")}
                      </a>
                    )}

                    {inquiry.status === "open" && (
                      <button
                        type="button"
                        className="inquiries-close-link"
                        disabled={busyId === inquiry.inquiryId}
                        onClick={() => handleClose(inquiry.inquiryId)}
                      >
                        {t("inquiries.close")}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { listReceivedInquiries, closeInquiry, markInquiryResponded, replyToInquiry } from "../../services/api";
import type { Inquiry } from "../../services/api";
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

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 5 5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InquiriesScreen() {
  const { t } = useLanguage();
  const [state, setState] = useState<LoadState>("loading");
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyError, setReplyError] = useState(false);

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

  async function handleMarkResponded(inquiryId: string) {
    setBusyId(inquiryId);
    try {
      await markInquiryResponded(inquiryId);
      setInquiries((prev) =>
        prev.map((item) => (item.inquiryId === inquiryId ? { ...item, respondedAt: new Date().toISOString() } : item)),
      );
    } finally {
      setBusyId(null);
    }
  }

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

  function startReply(inquiryId: string) {
    setReplyingId(inquiryId);
    setReplyDraft("");
    setReplyError(false);
  }

  function cancelReply() {
    setReplyingId(null);
    setReplyDraft("");
    setReplyError(false);
  }

  async function handleSendReply(inquiryId: string) {
    if (!replyDraft.trim()) {
      setReplyError(true);
      return;
    }
    setBusyId(inquiryId);
    try {
      await replyToInquiry(inquiryId, replyDraft.trim());
      setInquiries((prev) =>
        prev.map((item) =>
          item.inquiryId === inquiryId
            ? { ...item, replyMessage: replyDraft.trim(), respondedAt: new Date().toISOString() }
            : item,
        ),
      );
      setReplyingId(null);
      setReplyDraft("");
    } catch {
      setReplyError(true);
    } finally {
      setBusyId(null);
    }
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
            const isUnread = !inquiry.readAt;
            const isResponded = Boolean(inquiry.respondedAt);
            const whatsappTarget =
              inquiry.contactPreference !== "email" && inquiry.contactValue ? inquiry.contactValue : null;

            return (
              <li key={inquiry.inquiryId} className="inquiries-item">
                {inquiry.product && <img src={inquiry.product.imageUrl} alt="" className="inquiries-item-photo" />}
                <div className="inquiries-item-body">
                  <div className="inquiries-item-header">
                    <p className="inquiries-item-title">{title}</p>
                    {isUnread && <span className="inquiries-badge inquiries-badge-new">{t("inquiries.badgeNew")}</span>}
                  </div>
                  {inquiry.product && (
                    <p className="caption inquiries-item-passport">{inquiry.product.passportId}</p>
                  )}
                  <p className="body-s inquiries-item-message">{inquiry.message}</p>
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

                  {inquiry.replyMessage && (
                    <div className="inquiries-reply-sent">
                      <p className="caption inquiries-reply-sent-label">{t("inquiries.yourReply")}</p>
                      <p className="body-s">{inquiry.replyMessage}</p>
                    </div>
                  )}

                  {replyingId === inquiry.inquiryId && (
                    <div className="inquiries-reply-form">
                      <label className="visually-hidden" htmlFor={`reply-${inquiry.inquiryId}`}>
                        {t("inquiries.replyPlaceholder")}
                      </label>
                      <textarea
                        id={`reply-${inquiry.inquiryId}`}
                        className={`inquiries-reply-textarea${replyError ? " inquiries-reply-textarea-error" : ""}`}
                        rows={3}
                        placeholder={t("inquiries.replyPlaceholder")}
                        value={replyDraft}
                        onChange={(event) => {
                          setReplyDraft(event.target.value);
                          setReplyError(false);
                        }}
                        disabled={busyId === inquiry.inquiryId}
                      />
                      {replyError && (
                        <p className="field-error" role="alert">
                          {t("inquiries.replyRequired")}
                        </p>
                      )}
                      <div className="inquiries-reply-actions">
                        <Button
                          variant="primary"
                          loading={busyId === inquiry.inquiryId}
                          onClick={() => handleSendReply(inquiry.inquiryId)}
                        >
                          {t("inquiries.sendReply")}
                        </Button>
                        <Button variant="tertiary" disabled={busyId === inquiry.inquiryId} onClick={cancelReply}>
                          {t("home.editCancel")}
                        </Button>
                      </div>
                    </div>
                  )}

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

                    {!inquiry.replyMessage && replyingId !== inquiry.inquiryId && (
                      <Button variant="secondary" onClick={() => startReply(inquiry.inquiryId)}>
                        {t("inquiries.reply")}
                      </Button>
                    )}

                    {isResponded ? (
                      <span className="inquiries-badge inquiries-badge-responded">
                        <CheckIcon />
                        {t("inquiries.badgeResponded")}
                      </span>
                    ) : (
                      <Button
                        variant="tertiary"
                        loading={busyId === inquiry.inquiryId}
                        onClick={() => handleMarkResponded(inquiry.inquiryId)}
                      >
                        {t("inquiries.markResponded")}
                      </Button>
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

import { useState } from "react";
import { Button } from "./Button";
import { sendInquiryMessage } from "../services/api";
import type { Inquiry, InquiryMessage, InquirySenderRole } from "../services/api";
import { useLanguage } from "../context/LanguageContext";
import "./InquiryThread.css";

interface InquiryThreadProps {
  inquiry: Inquiry;
  viewerRole: InquirySenderRole;
  onSent: (message: InquiryMessage) => void;
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 4 16 8-16 8 4-8-4-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export function InquiryThread({ inquiry, viewerRole, onSent }: InquiryThreadProps) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!draft.trim()) {
      setError(true);
      return;
    }
    setSending(true);
    try {
      const result = await sendInquiryMessage(inquiry.inquiryId, draft.trim());
      onSent({ messageId: result.messageId, senderRole: viewerRole, body: draft.trim(), createdAt: result.createdAt });
      setDraft("");
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="inquiry-thread">
      <ul className="inquiry-thread-messages">
        {inquiry.messages.map((message) => (
          <li
            key={message.messageId}
            className={`inquiry-thread-bubble${message.senderRole === viewerRole ? " inquiry-thread-bubble-own" : ""}`}
          >
            <p className="caption inquiry-thread-sender">
              {message.senderRole === viewerRole
                ? t("inquiryThread.you")
                : t(viewerRole === "buyer" ? "inquiryThread.artisan" : "inquiryThread.buyer")}
            </p>
            <p className="body-s inquiry-thread-body">{message.body}</p>
          </li>
        ))}
      </ul>

      {inquiry.status === "open" ? (
        <div className="inquiry-thread-composer">
          <label className="visually-hidden" htmlFor={`thread-${inquiry.inquiryId}`}>
            {t("inquiryThread.placeholder")}
          </label>
          <textarea
            id={`thread-${inquiry.inquiryId}`}
            className={`inquiry-thread-textarea${error ? " inquiry-thread-textarea-error" : ""}`}
            rows={2}
            placeholder={t("inquiryThread.placeholder")}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(false);
            }}
            disabled={sending}
          />
          {error && (
            <p className="field-error" role="alert">
              {t("inquiryThread.messageRequired")}
            </p>
          )}
          <Button variant="primary" icon={<SendIcon />} loading={sending} onClick={handleSend}>
            {t("inquiryThread.send")}
          </Button>
        </div>
      ) : (
        <p className="caption inquiry-thread-closed-note">{t("inquiryThread.closedNote")}</p>
      )}
    </div>
  );
}

import { useState } from "react";
import { Button } from "./Button";
import { sendInquiryMessage, translateUnknownText } from "../services/api";
import type { Inquiry, InquiryMessage, InquirySenderRole } from "../services/api";
import { useLanguage } from "../context/LanguageContext";
import { getLanguage, isAppLanguage, isWrittenInOwnScript } from "../../shared/languages";
import "./InquiryThread.css";

interface InquiryThreadProps {
  inquiry: Inquiry;
  viewerRole: InquirySenderRole;
  onSent: (message: InquiryMessage) => void;
}

type TranslationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; text: string; from: string | null; showing: "translation" | "original" };

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 4 16 8-16 8 4-8-4-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function TranslateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6h10M8 4v2c0 4-2 7-5 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 12c1.5 2.5 3.5 4 6 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m13 21 4-10 4 10M14.6 18h4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function nameOf(code: string): string {
  const language = getLanguage(code);
  return language.nativeName === language.englishName
    ? language.englishName
    : `${language.nativeName} (${language.englishName})`;
}

function MessageBubble({
  message,
  viewerRole,
}: {
  message: InquiryMessage;
  viewerRole: InquirySenderRole;
}) {
  const { t, language } = useLanguage();
  const [translation, setTranslation] = useState<TranslationState>({ status: "idle" });

  const isOwn = message.senderRole === viewerRole;
  const hint = message.bodyLanguage && isAppLanguage(message.bodyLanguage) ? message.bodyLanguage : null;

  /**
   * The recorded language is only a hint, so it can rule the button out only
   * when the text is also in that language's own script. Someone writing
   * romanised Hindi with the app set to Hindi still needs the offer, and so
   * does a reader whose own language the message merely claims to be in.
   */
  const alreadyReadable = hint === language && isWrittenInOwnScript(message.body, language);
  const canTranslate = !isOwn && !alreadyReadable;

  async function handleTranslate() {
    setTranslation({ status: "loading" });
    try {
      const result = await translateUnknownText(message.body, language, hint);
      setTranslation({ status: "done", text: result.translation, from: result.from, showing: "translation" });
    } catch {
      setTranslation({ status: "error" });
    }
  }

  const showingTranslation = translation.status === "done" && translation.showing === "translation";
  const sameLanguage =
    translation.status === "done" && translation.from === language && translation.text === message.body;

  return (
    <li className={`inquiry-thread-bubble${isOwn ? " inquiry-thread-bubble-own" : ""}`}>
      <p className="caption inquiry-thread-sender">
        {isOwn
          ? t("inquiryThread.you")
          : t(viewerRole === "buyer" ? "inquiryThread.artisan" : "inquiryThread.buyer")}
      </p>

      <p className="body-s inquiry-thread-body">
        {showingTranslation ? translation.text : message.body}
      </p>

      {translation.status === "done" && (
        <>
          <p className="caption inquiry-thread-translation-note">
            {sameLanguage
              ? t("inquiryThread.alreadyInLanguage", { to: nameOf(language) })
              : translation.from
                ? t("inquiryThread.translatedFromTo", {
                    from: nameOf(translation.from),
                    to: nameOf(language),
                  })
                : t("inquiryThread.translatedTo", { to: nameOf(language) })}
          </p>
          {!sameLanguage && (
            <button
              type="button"
              className="inquiry-thread-translate"
              onClick={() =>
                setTranslation({ ...translation, showing: showingTranslation ? "original" : "translation" })
              }
            >
              {showingTranslation ? t("inquiryThread.showOriginal") : t("inquiryThread.showTranslation")}
            </button>
          )}
        </>
      )}

      {translation.status === "error" && (
        <p className="caption inquiry-thread-translation-error" role="alert">
          {t("inquiryThread.translateFailed")}
        </p>
      )}

      {canTranslate && translation.status !== "done" && (
        <button
          type="button"
          className="inquiry-thread-translate"
          onClick={handleTranslate}
          disabled={translation.status === "loading"}
        >
          <TranslateIcon />
          {translation.status === "loading"
            ? t("inquiryThread.translating")
            : t("inquiryThread.translate", { to: nameOf(language) })}
        </button>
      )}
    </li>
  );
}

export function InquiryThread({ inquiry, viewerRole, onSent }: InquiryThreadProps) {
  const { t, language } = useLanguage();
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
      const result = await sendInquiryMessage(inquiry.inquiryId, draft.trim(), language);
      onSent({
        messageId: result.messageId,
        senderRole: viewerRole,
        body: draft.trim(),
        bodyLanguage: language,
        createdAt: result.createdAt,
      });
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
          <MessageBubble key={message.messageId} message={message} viewerRole={viewerRole} />
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

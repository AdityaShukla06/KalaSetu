import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { getTicketPreview, raiseTicket } from "../../services/api";
import type { TicketPreview } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Support.css";

type LoadState = "loading" | "invalid" | "loaded";
type SubmitState = "idle" | "sending" | "sent" | "error";

function CheckIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8 12.5 2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SupportTicketScreen() {
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [state, setState] = useState<LoadState>("loading");
  const [preview, setPreview] = useState<TicketPreview | null>(null);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");

  useEffect(() => {
    document.documentElement.style.setProperty("--shell-max-width", "none");
    return () => {
      document.documentElement.style.removeProperty("--shell-max-width");
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    let cancelled = false;
    getTicketPreview(token)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setState("loaded");
      })
      .catch(() => {
        if (cancelled) return;
        setState("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit() {
    if (!message.trim()) {
      setMessageError(true);
      return;
    }
    setSubmitState("sending");
    try {
      await raiseTicket(token, message.trim());
      setSubmitState("sent");
    } catch {
      setSubmitState("error");
    }
  }

  return (
    <div className="screen support-screen">
      <div className="support-card">
        {state === "loading" && (
          <>
            <Skeleton height="28px" width="70%" />
            <Skeleton height="100px" />
          </>
        )}

        {state === "invalid" && (
          <>
            <h1>{t("support.invalidTitle")}</h1>
            <p className="body-s support-helper">{t("support.invalidMessage")}</p>
          </>
        )}

        {state === "loaded" && preview && submitState !== "sent" && (
          <>
            <h1>{preview.title}</h1>
            {preview.context && <p className="body-s support-context">{preview.context}</p>}

            {preview.ticketType === "product_removal" && (
              <p className="caption support-permanent-note">{t("support.permanentNote")}</p>
            )}

            <label className="visually-hidden" htmlFor="ticket-message">
              {t("support.messagePlaceholder")}
            </label>
            <textarea
              id="ticket-message"
              className={`support-textarea${messageError ? " support-textarea-error" : ""}`}
              rows={6}
              placeholder={t("support.messagePlaceholder")}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                setMessageError(false);
                if (submitState === "error") setSubmitState("idle");
              }}
              disabled={submitState === "sending"}
            />
            {messageError && (
              <p className="field-error" role="alert">
                {t("support.messageRequired")}
              </p>
            )}

            {submitState === "error" && (
              <p className="onboarding-error" role="alert">
                {t("support.submitError")}
              </p>
            )}

            <Button variant="primary" loading={submitState === "sending"} onClick={handleSubmit}>
              {t("support.submit")}
            </Button>
          </>
        )}

        {submitState === "sent" && (
          <div className="support-sent">
            <span className="support-sent-icon">
              <CheckIcon />
            </span>
            <h1>{t("support.sentTitle")}</h1>
            <p className="body-s support-helper">{t("support.sentMessage")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

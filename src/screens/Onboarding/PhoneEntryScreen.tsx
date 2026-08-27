import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { sendOtp } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 3h4l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v4a2 2 0 0 1-2 2C11.4 20 4 12.6 4 5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m4 4 16 8-16 8 4-8-4-8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PhoneEntryScreen() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function handlePhoneChange(value: string) {
    setPhoneNumber(value.replace(/\D/g, "").slice(0, 10));
    if (error) setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!/^\d{10}$/.test(phoneNumber)) {
      setError(t("phone.invalid"));
      return;
    }

    setSending(true);
    setError(null);

    try {
      await sendOtp(phoneNumber);
      navigate("/otp", { state: { phoneNumber } });
    } catch {
      setError(t("phone.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="onboarding-screen" lang={language} onSubmit={handleSubmit}>
      <h1 className="onboarding-title">{t("phone.title")}</h1>

      <Input
        label={t("phone.label")}
        icon={<PhoneIcon />}
        prefix="+91"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={phoneNumber}
        onChange={(event) => handlePhoneChange(event.target.value)}
        error={error ?? undefined}
        maxLength={10}
      />

      <p className="body-s onboarding-helper">{t("phone.helper")}</p>

      <Button type="submit" variant="primary" icon={<SendIcon />} loading={sending}>
        {t("phone.sendOtp")}
      </Button>
    </form>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { OtpInput } from "../../components/OtpInput";
import { sendOtp, verifyOtp } from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

const RESEND_COOLDOWN_SECONDS = 30;

interface OtpVerificationScreenProps {
  phoneNumber: string;
  onChangeNumber: () => void;
}

function ShieldIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OtpVerificationScreen({ phoneNumber, onChangeNumber }: OtpVerificationScreenProps) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { language, t } = useLanguage();

  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((prev) => Math.max(prev - 1, 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function handleOtpChange(value: string) {
    setOtp(value);
    if (error) setError(null);
  }

  async function handleVerify() {
    if (otp.length !== 6) {
      setError(t("otp.invalid"));
      return;
    }

    setVerifying(true);
    setError(null);

    try {
      const { token, userId } = await verifyOtp(phoneNumber, otp);
      login(token, userId, phoneNumber);
      navigate("/", { replace: true });
    } catch {
      setOtp("");
      setError(t("otp.wrong"));
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;

    setResending(true);
    setError(null);

    try {
      await sendOtp(phoneNumber);
      setOtp("");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError(t("otp.resendError"));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="onboarding-screen" lang={language}>
      <h1 className="onboarding-title">{t("otp.title")}</h1>
      <p className="body-s onboarding-helper">
        {t("otp.subtitle")} +91 {phoneNumber}
      </p>

      <OtpInput value={otp} onChange={handleOtpChange} error={Boolean(error)} disabled={verifying} />

      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}

      <Button variant="primary" icon={<ShieldIcon />} loading={verifying} onClick={handleVerify}>
        {t("otp.verify")}
      </Button>

      <div className="onboarding-otp-actions">
        <button type="button" className="onboarding-link" onClick={onChangeNumber}>
          {t("otp.changeNumber")}
        </button>
        <button
          type="button"
          className="onboarding-link"
          onClick={handleResend}
          disabled={cooldown > 0 || resending}
        >
          {cooldown > 0 ? t("otp.resendIn", { n: cooldown }) : t("otp.resend")}
        </button>
      </div>
    </div>
  );
}

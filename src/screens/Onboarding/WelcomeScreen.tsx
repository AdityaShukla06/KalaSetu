import { Button } from "../../components/Button";
import { LanguageSelect } from "../../components/LanguageSelect";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

interface WelcomeScreenProps {
  onGetStarted: () => void;
}

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  const { language, t } = useLanguage();

  return (
    <div className="onboarding-screen onboarding-screen-center" lang={language}>
      <div className="onboarding-hero">
        <img src="/icons/logo-mark.png" alt="" className="onboarding-logo" />
        <h1>{t("app.name")}</h1>
        <p className="body-s onboarding-tagline">{t("welcome.tagline")}</p>
      </div>

      <div className="onboarding-section">
        <LanguageSelect label={t("welcome.languageLabel")} />
        <p className="caption onboarding-section-hint">{t("welcome.languageHint")}</p>
      </div>

      <Button variant="primary" icon={<ArrowIcon />} onClick={onGetStarted}>
        {t("welcome.getStarted")}
      </Button>
    </div>
  );
}

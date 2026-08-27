import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { LanguageToggle } from "../../components/LanguageToggle";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WelcomeScreen() {
  const navigate = useNavigate();
  const { language, t } = useLanguage();

  return (
    <div className="onboarding-screen onboarding-screen-center" lang={language}>
      <div className="onboarding-hero">
        <h1>{t("app.name")}</h1>
        <p className="body-s onboarding-tagline">{t("welcome.tagline")}</p>
      </div>

      <div className="onboarding-section">
        <p className="caption onboarding-section-label">{t("welcome.languageLabel")}</p>
        <LanguageToggle />
      </div>

      <Button variant="primary" icon={<ArrowIcon />} onClick={() => navigate("/phone")}>
        {t("welcome.getStarted")}
      </Button>
    </div>
  );
}

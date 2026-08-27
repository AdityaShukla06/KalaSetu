import { useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import "./Home.css";

function StorefrontIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9v10h16V9M3 9l1.5-5h15L21 9M3 9h18M9 19v-5h6v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GemOndcBanner() {
  const { t } = useLanguage();
  const [showMessage, setShowMessage] = useState(false);

  return (
    <div className="gem-banner">
      <button
        type="button"
        className="gem-banner-tap"
        onClick={() => setShowMessage((prev) => !prev)}
        aria-expanded={showMessage}
      >
        <span className="gem-banner-icon">
          <StorefrontIcon />
        </span>
        <span className="gem-banner-text">
          <span className="gem-banner-title">{t("home.gemBannerTitle")}</span>
          <span className="gem-banner-badge">{t("home.gemBannerBadge")}</span>
        </span>
      </button>
      {showMessage && <p className="caption gem-banner-message">{t("home.gemBannerMessage")}</p>}
    </div>
  );
}

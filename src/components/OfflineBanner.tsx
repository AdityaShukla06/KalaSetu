import { useEffect, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import "./AppBanners.css";

function OfflineIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M8.5 8.5A11 11 0 0 1 20 9M5 12.5a10.9 10.9 0 0 1 3.2-2.9M12 19h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OfflineBanner() {
  const { t } = useLanguage();
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="app-banner app-banner-offline" role="status">
      <OfflineIcon />
      <span className="app-banner-text">{t("offline.message")}</span>
    </div>
  );
}

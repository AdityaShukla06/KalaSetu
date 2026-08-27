import { useLanguage } from "../context/LanguageContext";
import "./LanguageToggle.css";

export function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="language-toggle" role="group" aria-label={t("welcome.languageLabel")}>
      <button
        type="button"
        className={`language-option${language === "en" ? " language-option-active" : ""}`}
        onClick={() => setLanguage("en")}
      >
        {t("language.en")}
      </button>
      <button
        type="button"
        className={`language-option${language === "hi" ? " language-option-active" : ""}`}
        onClick={() => setLanguage("hi")}
      >
        {t("language.hi")}
      </button>
    </div>
  );
}

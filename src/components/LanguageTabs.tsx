import { useLanguage } from "../context/LanguageContext";
import "./LanguageTabs.css";

export type DescriptionTab = "en" | "local";

interface LanguageTabsProps {
  value: DescriptionTab;
  onChange: (tab: DescriptionTab) => void;
}

export function LanguageTabs({ value, onChange }: LanguageTabsProps) {
  const { language, t } = useLanguage();

  if (language === "en") return null;

  return (
    <div className="lang-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={value === "en"}
        className={`lang-tab${value === "en" ? " lang-tab-active" : ""}`}
        onClick={() => onChange("en")}
      >
        {t("language.en")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === "local"}
        className={`lang-tab${value === "local" ? " lang-tab-active" : ""}`}
        onClick={() => onChange("local")}
      >
        {t("describe.localTab")}
      </button>
    </div>
  );
}

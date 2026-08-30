import { useId } from "react";
import { useLanguage } from "../context/LanguageContext";
import { AVAILABLE_LANGUAGES } from "../context/translations";
import "./LanguageSelect.css";

interface LanguageSelectProps {
  label?: string;
}

function GlobeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LanguageSelect({ label }: LanguageSelectProps) {
  const { language, setLanguage, t } = useLanguage();
  const id = useId();

  const english = AVAILABLE_LANGUAGES.filter((entry) => entry.code === "en");
  const regional = AVAILABLE_LANGUAGES.filter((entry) => entry.code !== "en");

  return (
    <div className="language-select">
      {label && (
        <label className="language-select-label" htmlFor={id}>
          {label}
        </label>
      )}
      <div className="language-select-control">
        <span className="language-select-icon" aria-hidden="true">
          <GlobeIcon />
        </span>
        <select
          id={id}
          className="language-select-input"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          aria-label={label ?? t("welcome.languageLabel")}
        >
          {english.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.nativeName}
            </option>
          ))}
          <optgroup label={t("welcome.regionalLanguages")}>
            {regional.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.nativeName} ({entry.englishName})
              </option>
            ))}
          </optgroup>
        </select>
        <span className="language-select-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </div>
    </div>
  );
}

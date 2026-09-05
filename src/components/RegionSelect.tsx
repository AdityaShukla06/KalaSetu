import { useId } from "react";
import { INDIAN_REGIONS } from "../../shared/regions";
import { useLanguage } from "../context/LanguageContext";
import "./RegionSelect.css";

interface RegionSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function PinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.6" />
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

export function RegionSelect({ label, value, onChange }: RegionSelectProps) {
  const { t } = useLanguage();
  const id = useId();

  return (
    <div className="region-select">
      <label className="region-select-label" htmlFor={id}>
        {label}
      </label>
      <div className="region-select-control">
        <span className="region-select-icon" aria-hidden="true">
          <PinIcon />
        </span>
        <select id={id} className="region-select-input" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t("marketplace.regionUnspecified")}</option>
          {INDIAN_REGIONS.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
        <span className="region-select-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import "./AddProduct.css";

interface BeforeAfterCompareProps {
  originalUrl: string;
  enhancedUrl: string;
}

export function BeforeAfterCompare({ originalUrl, enhancedUrl }: BeforeAfterCompareProps) {
  const { t } = useLanguage();
  const [reveal, setReveal] = useState(55);

  return (
    <div className="compare-viewer">
      <img src={originalUrl} alt="" className="compare-layer" />

      <div className="compare-reveal" style={{ clipPath: `inset(0 0 0 ${reveal}%)` }}>
        <img src={enhancedUrl} alt="" className="compare-layer" />
      </div>

      <span className="compare-tag compare-tag-left">{t("camera.before")}</span>
      <span className="compare-tag compare-tag-right">{t("camera.after")}</span>

      <div className="compare-divider" style={{ left: `${reveal}%` }} aria-hidden="true">
        <span className="compare-knob" />
      </div>

      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={reveal}
        onChange={(event) => setReveal(Number(event.target.value))}
        className="compare-range"
        aria-label={t("camera.compareHint")}
      />
    </div>
  );
}

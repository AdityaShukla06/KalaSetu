import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { materialsForCategory } from "../../../shared/materials";
import type { CategorySuggestion } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./VoiceDescribe.css";

interface CategoryStepProps {
  initialCategory: string | null;
  initialMaterial?: string | null;
  suggestion?: CategorySuggestion;
  suggestionPending?: boolean;
  onContinue: (category: string, material?: string) => void;
}

function TextileIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3 5 6v3l2-1v11h10V8l2 1V6l-3-3-2 2h-2L8 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PotteryIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 3h6M8 3c0 3-2 3-2 6 0 5 2 9 6 9s6-4 6-9c0-3-2-3-2-6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function JewelryIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m12 3 4 5-4 13-4-13 4-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 8h8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function WoodworkIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m4 15 9-9 3 3-9 9-4 1 1-4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="m14 5 3-2 3 3-2 3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function BambooIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 21V3M9 7h6M9 13h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15 21V3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function OtherIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

export const CATEGORIES = [
  { id: "textiles", labelKey: "category.textiles", Icon: TextileIcon },
  { id: "pottery", labelKey: "category.pottery", Icon: PotteryIcon },
  { id: "jewelry", labelKey: "category.jewelry", Icon: JewelryIcon },
  { id: "woodwork", labelKey: "category.woodwork", Icon: WoodworkIcon },
  { id: "bamboo-cane", labelKey: "category.bambooCane", Icon: BambooIcon },
  { id: "other", labelKey: "category.other", Icon: OtherIcon },
];

export function CategoryStep({
  initialCategory,
  initialMaterial,
  suggestion,
  suggestionPending,
  onContinue,
}: CategoryStepProps) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<string | null>(initialCategory);
  const [material, setMaterial] = useState<string | null>(initialMaterial ?? null);
  const [touched, setTouched] = useState(false);
  const availableMaterials = selected ? materialsForCategory(selected) : [];

  useEffect(() => {
    if (!suggestion || touched || selected) return;
    if (suggestion.confidence === "low") return;

    setSelected(suggestion.category);
    if (suggestion.material && materialsForCategory(suggestion.category).includes(suggestion.material)) {
      setMaterial(suggestion.material);
    }
  }, [suggestion, touched, selected]);

  function handleSelectCategory(id: string) {
    setTouched(true);
    setSelected(id);
    if (material && !materialsForCategory(id).includes(material)) {
      setMaterial(null);
    }
  }

  const showSuggestionHint = Boolean(suggestion) && !touched && selected === suggestion?.category;
  const showDetecting = Boolean(suggestionPending) && !suggestion;

  return (
    <div className="describe-screen">
      <h1>{t("category.title")}</h1>

      <div className="category-grid">
        {CATEGORIES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={`category-tile${selected === id ? " category-tile-active" : ""}`}
            onClick={() => handleSelectCategory(id)}
            aria-pressed={selected === id}
          >
            {suggestion?.category === id && !touched && (
              <span className="category-tile-badge">{t("category.suggested")}</span>
            )}
            <span className="category-tile-icon">
              <Icon />
            </span>
            <span className="category-tile-label">{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {showDetecting && <p className="body-s category-suggestion-note">{t("category.detecting")}</p>}
      {showSuggestionHint && <p className="body-s category-suggestion-note">{t("category.suggestionHint")}</p>}

      {selected && (
        <div className="material-section">
          <span className="body-s material-question">{t("category.materialQuestion")}</span>
          <div className="material-chip-row">
            {availableMaterials.map((entry) => (
              <button
                key={entry}
                type="button"
                className={`material-chip${material === entry ? " material-chip-active" : ""}`}
                onClick={() => setMaterial(material === entry ? null : entry)}
                aria-pressed={material === entry}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      )}

      <Button
        variant="primary"
        disabled={!selected}
        onClick={() => selected && onContinue(selected, material ?? undefined)}
      >
        {t("category.continue")}
      </Button>
    </div>
  );
}

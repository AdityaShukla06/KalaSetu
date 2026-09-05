import { useId } from "react";
import type { MarketplaceFilters, MarketplaceSort } from "../../services/api";
import { CATEGORIES } from "../AddProduct/CategoryStep";
import { PRODUCT_MATERIALS } from "../../../shared/materials";
import { INDIAN_REGIONS } from "../../../shared/regions";
import { useLanguage } from "../../context/LanguageContext";
import "./FilterPanel.css";

interface FilterPanelProps {
  filters: MarketplaceFilters;
  onChange: (filters: MarketplaceFilters) => void;
  onClear: () => void;
}

export function FilterPanel({ filters, onChange, onClear }: FilterPanelProps) {
  const { t } = useLanguage();
  const materialId = useId();
  const regionId = useId();
  const sortId = useId();
  const minId = useId();
  const maxId = useId();

  function update(patch: Partial<MarketplaceFilters>) {
    onChange({ ...filters, ...patch });
  }

  return (
    <div className="filter-panel">
      <div className="filter-panel-header">
        <h3>{t("marketplace.filtersTitle")}</h3>
        <button type="button" className="filter-clear" onClick={onClear}>
          {t("marketplace.filtersClear")}
        </button>
      </div>

      <div className="filter-field">
        <span className="filter-label">{t("category.title")}</span>
        <div className="filter-chip-row">
          <button
            type="button"
            className={`filter-chip${!filters.category ? " filter-chip-active" : ""}`}
            onClick={() => update({ category: undefined })}
          >
            {t("marketplace.filterAll")}
          </button>
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`filter-chip${filters.category === category.id ? " filter-chip-active" : ""}`}
              onClick={() => update({ category: category.id })}
            >
              {t(category.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-field">
        <label className="filter-label" htmlFor={materialId}>
          {t("marketplace.filterMaterial")}
        </label>
        <select
          id={materialId}
          className="filter-select"
          value={filters.material ?? ""}
          onChange={(event) => update({ material: event.target.value || undefined })}
        >
          <option value="">{t("marketplace.filterAll")}</option>
          {PRODUCT_MATERIALS.map((material) => (
            <option key={material} value={material}>
              {material}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label className="filter-label" htmlFor={regionId}>
          {t("marketplace.filterRegion")}
        </label>
        <select
          id={regionId}
          className="filter-select"
          value={filters.region ?? ""}
          onChange={(event) => update({ region: event.target.value || undefined })}
        >
          <option value="">{t("marketplace.filterAll")}</option>
          {INDIAN_REGIONS.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <span className="filter-label">{t("marketplace.filterPrice")}</span>
        <div className="filter-price-row">
          <label className="visually-hidden" htmlFor={minId}>
            {t("marketplace.filterPriceMin")}
          </label>
          <input
            id={minId}
            type="number"
            inputMode="numeric"
            min="0"
            placeholder={t("marketplace.filterPriceMin")}
            className="filter-price-input"
            value={filters.minPrice ?? ""}
            onChange={(event) =>
              update({ minPrice: event.target.value ? Number(event.target.value) : undefined })
            }
          />
          <span className="filter-price-sep" aria-hidden="true">
            –
          </span>
          <label className="visually-hidden" htmlFor={maxId}>
            {t("marketplace.filterPriceMax")}
          </label>
          <input
            id={maxId}
            type="number"
            inputMode="numeric"
            min="0"
            placeholder={t("marketplace.filterPriceMax")}
            className="filter-price-input"
            value={filters.maxPrice ?? ""}
            onChange={(event) =>
              update({ maxPrice: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </div>
      </div>

      <div className="filter-field">
        <label className="filter-label" htmlFor={sortId}>
          {t("marketplace.sortLabel")}
        </label>
        <select
          id={sortId}
          className="filter-select"
          value={filters.sort ?? "newest"}
          onChange={(event) => update({ sort: event.target.value as MarketplaceSort })}
        >
          <option value="newest">{t("marketplace.sortNewest")}</option>
          <option value="price_asc">{t("marketplace.sortPriceAsc")}</option>
          <option value="price_desc">{t("marketplace.sortPriceDesc")}</option>
        </select>
      </div>
    </div>
  );
}

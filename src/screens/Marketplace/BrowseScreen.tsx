import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { FilterPanel } from "./FilterPanel";
import { MarketplaceProductCard } from "./MarketplaceProductCard";
import { searchMarketplace } from "../../services/api";
import type { MarketplaceFilters, Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Browse.css";

type LoadState = "loading" | "error" | "loaded";

const SEARCH_DEBOUNCE_MS = 350;
const PAGE_SIZE = 12;

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6h16M7 12h10M10 18h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8v5M12 16.5h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProductCardSkeleton() {
  return (
    <div className="marketplace-product-card marketplace-product-card-skeleton">
      <Skeleton height="0" className="marketplace-product-photo-skeleton" />
      <div className="marketplace-product-body">
        <Skeleton height="18px" width="80%" />
        <Skeleton height="18px" width="40%" />
        <Skeleton height="14px" width="60%" />
      </div>
    </div>
  );
}

export function BrowseScreen() {
  const { t } = useLanguage();

  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState<MarketplaceFilters>({ sort: "newest", limit: PAGE_SIZE });
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [items, setItems] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const requestId = useRef(0);

  const fetchPage = useCallback(
    async (targetPage: number, activeFilters: MarketplaceFilters) => {
      const thisRequest = ++requestId.current;
      if (targetPage === 1) setLoadState("loading");
      else setLoadingMore(true);

      try {
        const result = await searchMarketplace({ ...activeFilters, page: targetPage });
        if (thisRequest !== requestId.current) return;

        setItems((prev) => (targetPage === 1 ? result.items : [...prev, ...result.items]));
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
        setLoadState("loaded");
      } catch {
        if (thisRequest !== requestId.current) return;
        if (targetPage === 1) setLoadState("error");
      } finally {
        if (thisRequest === requestId.current) setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchPage(1, filters);
  }, [filters, fetchPage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) => {
        const trimmed = searchInput.trim();
        if ((prev.q ?? "") === trimmed) return prev;
        return { ...prev, q: trimmed || undefined };
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function handleClearFilters() {
    setSearchInput("");
    setFilters({ sort: "newest", limit: PAGE_SIZE });
  }

  function handleRetry() {
    fetchPage(1, filters);
  }

  function handleLoadMore() {
    fetchPage(page + 1, filters);
  }

  const hasActiveFilters =
    Boolean(filters.category || filters.material || filters.region || filters.minPrice || filters.maxPrice || filters.q);

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <h1>{t("marketplace.browseTitle")}</h1>

        <div className="browse-search-row">
          <div className="browse-search">
            <SearchIcon />
            <input
              type="search"
              placeholder={t("marketplace.searchPlaceholder")}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              aria-label={t("marketplace.searchPlaceholder")}
            />
          </div>
          <button
            type="button"
            className="browse-filter-toggle"
            onClick={() => setFiltersOpen((prev) => !prev)}
            aria-expanded={filtersOpen}
          >
            <FilterIcon />
            {t("marketplace.filtersTitle")}
          </button>
        </div>
      </div>

      <div className="browse-layout">
        <div className={`browse-filters${filtersOpen ? " browse-filters-open" : ""}`}>
          <FilterPanel filters={filters} onChange={setFilters} onClear={handleClearFilters} />
        </div>

        <div className="browse-results">
          {loadState === "loaded" && (
            <p className="body-s browse-result-count">
              {t("marketplace.resultCount", { n: total })}
            </p>
          )}

          {loadState === "loading" && (
            <div className="marketplace-product-grid">
              {Array.from({ length: PAGE_SIZE }).map((_, index) => (
                <ProductCardSkeleton key={index} />
              ))}
            </div>
          )}

          {loadState === "error" && (
            <div className="browse-state">
              <span className="browse-error-icon">
                <ErrorIcon />
              </span>
              <p className="body-s">{t("marketplace.loadError")}</p>
              <Button variant="primary" icon={<RetryIcon />} onClick={handleRetry}>
                {t("home.retry")}
              </Button>
            </div>
          )}

          {loadState === "loaded" && items.length === 0 && (
            <div className="browse-state">
              <span className="browse-empty-icon">
                <EmptyIcon />
              </span>
              <h3>{t("marketplace.emptyTitle")}</h3>
              <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
                {hasActiveFilters ? t("marketplace.emptyFiltered") : t("marketplace.emptyNoProducts")}
              </p>
              {hasActiveFilters && (
                <Button variant="secondary" onClick={handleClearFilters}>
                  {t("marketplace.filtersClear")}
                </Button>
              )}
            </div>
          )}

          {loadState === "loaded" && items.length > 0 && (
            <>
              <div className="marketplace-product-grid">
                {items.map((product) => (
                  <MarketplaceProductCard key={product.productId} product={product} />
                ))}
              </div>

              {hasMore && (
                <div className="browse-load-more">
                  <Button variant="secondary" loading={loadingMore} onClick={handleLoadMore}>
                    {t("marketplace.loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

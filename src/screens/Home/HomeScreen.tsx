import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { GemOndcBanner } from "./GemOndcBanner";
import { ProductCard } from "./ProductCard";
import { ProductDetailSheet } from "./ProductDetailSheet";
import { listProducts, type Product, type ProductWithViewCount } from "../../services/api";
import { buildCatalogExport, downloadJson } from "../../services/ondcExport";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Home.css";

type LoadState = "loading" | "error" | "loaded";

function PlusIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
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

function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function ErrorIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8v5M12 16.5h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HomeScreen() {
  const navigate = useNavigate();
  const { userId } = useAuth();
  const { t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [products, setProducts] = useState<ProductWithViewCount[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const loadProducts = useCallback(async () => {
    setState("loading");
    try {
      const result = await listProducts(userId ?? "");
      setProducts(result);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, [userId]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const publishedProducts = products.filter((product) => product.status === "published" && !product.flagged);

  function handleExportCatalog() {
    const exportData = buildCatalogExport(userId ?? "", publishedProducts);
    downloadJson(`kalasetu-ondc-catalog-${new Date().toISOString().slice(0, 10)}.json`, exportData);
  }

  return (
    <div className="screen home-screen">
      <div className="home-header-row">
        <h1>{t("home.title")}</h1>
        <div className="home-header-links">
          <button type="button" className="home-analytics-link" onClick={() => navigate("/inquiries")}>
            {t("home.viewInquiries")}
          </button>
          <button type="button" className="home-analytics-link" onClick={() => navigate("/analytics")}>
            {t("home.viewAnalytics")}
          </button>
        </div>
      </div>

      <GemOndcBanner />

      {state === "loading" && (
        <div className="home-state">
          <span className="home-spinner" aria-hidden="true" />
          <p className="body-s">{t("home.loading")}</p>
        </div>
      )}

      {state === "error" && (
        <div className="home-state">
          <span className="home-error-icon">
            <ErrorIcon />
          </span>
          <p className="body-s">{t("home.loadError")}</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={loadProducts}>
            {t("home.retry")}
          </Button>
        </div>
      )}

      {state === "loaded" && products.length === 0 && (
        <div className="home-state">
          <span className="home-empty-icon">
            <EmptyIcon />
          </span>
          <h3>{t("home.emptyTitle")}</h3>
          <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
            {t("home.emptyMessage")}
          </p>
          <Button variant="primary" icon={<PlusIcon />} onClick={() => navigate("/add-product/photo")}>
            {t("home.addFirstProduct")}
          </Button>
        </div>
      )}

      {state === "loaded" && products.length > 0 && (
        <div className="product-grid">
          {products.map((product) => (
            <ProductCard key={product.productId} product={product} onClick={() => setSelectedProduct(product)} />
          ))}
        </div>
      )}

      {state === "loaded" && publishedProducts.length > 0 && (
        <div className="home-export-section">
          <Button variant="secondary" icon={<DownloadIcon />} onClick={handleExportCatalog}>
            {t("home.exportCatalog")}
          </Button>
          <p className="caption home-export-note">{t("home.exportCatalogNote")}</p>
        </div>
      )}

      {selectedProduct && (
        <ProductDetailSheet
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onChanged={loadProducts}
        />
      )}
    </div>
  );
}

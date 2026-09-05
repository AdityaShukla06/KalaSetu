import type { ProductWithViewCount } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Home.css";

interface ProductCardProps {
  product: ProductWithViewCount;
  onClick: () => void;
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

const STATUS_LABEL_KEY: Record<ProductWithViewCount["status"], string> = {
  published: "home.statusPublished",
  draft: "home.statusDraft",
  failed: "home.statusFailed",
};

export function ProductCard({ product, onClick }: ProductCardProps) {
  const { language, t } = useLanguage();
  const title = language === product.localLanguage ? product.titleLocal : product.titleEn;
  const description = language === product.localLanguage ? product.descriptionLocal : product.descriptionEn;

  return (
    <button type="button" className="product-card" onClick={onClick}>
      <div className="product-card-photo-wrap">
        <img src={product.imageUrl} alt="" className="product-card-photo" />
        <span className={`product-card-badge product-card-badge-${product.status}`}>
          {t(STATUS_LABEL_KEY[product.status])}
        </span>
      </div>
      <div className="product-card-body">
        <p className="product-card-title">{title}</p>
        <p className="caption product-card-description">{description}</p>
        <div className="product-card-footer">
          <p className="product-card-price">₹{product.price}</p>
          <span className="product-card-views">
            <EyeIcon />
            {product.viewCount}
          </span>
        </div>
      </div>
    </button>
  );
}

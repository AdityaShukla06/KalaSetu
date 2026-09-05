import { Link } from "react-router-dom";
import type { Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Browse.css";

interface MarketplaceProductCardProps {
  product: Product;
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

export function MarketplaceProductCard({ product }: MarketplaceProductCardProps) {
  const { language, t } = useLanguage();
  const title = language === product.localLanguage ? product.titleLocal : product.titleEn;

  return (
    <Link to={`/marketplace/${product.productId}`} className="marketplace-product-card">
      <div className="marketplace-product-photo-wrap">
        <img src={product.imageUrl} alt="" className="marketplace-product-photo" loading="lazy" />
      </div>
      <div className="marketplace-product-body">
        <p className="marketplace-product-title">{title}</p>
        <p className="marketplace-product-price">₹{product.price}</p>
        <p className="caption marketplace-product-artisan">
          {product.artisanName ?? t("marketplace.artisanUnnamed")}
        </p>
        {product.region && (
          <p className="caption marketplace-product-region">
            <PinIcon />
            {product.region}
          </p>
        )}
      </div>
    </Link>
  );
}

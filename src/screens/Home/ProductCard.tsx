import type { Product } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Home.css";

interface ProductCardProps {
  product: Product;
  onClick: () => void;
}

const STATUS_LABEL_KEY: Record<Product["status"], string> = {
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
        <p className="product-card-price">₹{product.price}</p>
      </div>
    </button>
  );
}

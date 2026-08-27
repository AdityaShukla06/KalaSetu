import { useLayoutEffect, useState } from "react";
import { Button } from "../../components/Button";
import { enhanceImage } from "../../services/api";
import { useAddProductDraft } from "../../context/AddProductDraftContext";
import { useLanguage } from "../../context/LanguageContext";
import "./AddProduct.css";

interface PhotoReviewFlowProps {
  blob: Blob;
  onRetake: () => void;
  onDone: () => void;
}

type Step = "reviewing" | "enhancing" | "enhance-error" | "compare";

function RetakeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 11a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 5 5 9-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PhotoReviewFlow({ blob, onRetake, onDone }: PhotoReviewFlowProps) {
  const { t } = useLanguage();
  const { updateDraft } = useAddProductDraft();
  const [step, setStep] = useState<Step>("reviewing");
  const [enhancedUrl, setEnhancedUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    const url = URL.createObjectURL(blob);
    setOriginalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  if (!originalUrl) return null;

  async function handleUsePhoto() {
    setStep("enhancing");
    try {
      const { enhancedImageUrl } = await enhanceImage(blob);
      setEnhancedUrl(enhancedImageUrl);
      updateDraft({ imageBlob: blob, imageUrl: enhancedImageUrl });
      setStep("compare");
    } catch {
      setStep("enhance-error");
    }
  }

  if (step === "reviewing") {
    return (
      <div className="camera-screen">
        <img src={originalUrl} alt="" className="camera-video" />
        <div className="camera-review-actions">
          <Button variant="secondary" icon={<RetakeIcon />} onClick={onRetake}>
            {t("camera.retake")}
          </Button>
          <Button variant="primary" icon={<CheckIcon />} onClick={handleUsePhoto}>
            {t("camera.usePhoto")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "enhancing") {
    return (
      <div className="camera-loading">
        <span className="camera-spinner" aria-hidden="true" />
        <p className="body-s">{t("camera.enhancing")}</p>
      </div>
    );
  }

  if (step === "enhance-error") {
    return (
      <div className="camera-loading">
        <p className="body-s onboarding-error" role="alert">
          {t("camera.enhanceError")}
        </p>
        <Button variant="primary" icon={<RetakeIcon />} onClick={handleUsePhoto}>
          {t("camera.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="compare-screen">
      <div className="compare-images">
        <div className="compare-item">
          <p className="caption">{t("camera.before")}</p>
          <img src={originalUrl} alt="" className="compare-image" />
        </div>
        <div className="compare-item">
          <p className="caption">{t("camera.after")}</p>
          <img src={enhancedUrl ?? originalUrl} alt="" className="compare-image" />
        </div>
      </div>
      <Button variant="primary" icon={<ArrowIcon />} onClick={onDone}>
        {t("camera.continue")}
      </Button>
    </div>
  );
}

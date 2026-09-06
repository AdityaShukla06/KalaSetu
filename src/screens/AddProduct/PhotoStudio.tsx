import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { removeImageBackground, finalizeImage } from "../../services/api";
import type { BackgroundFill, CropPreset, StudioOptions } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./AddProduct.css";
import "./PhotoStudio.css";

interface PhotoStudioProps {
  blob: Blob;
  originalUrl: string;
  enhancedUrl: string;
  onAccept: (finalImageUrl: string) => void;
  onRetake: () => void;
}

type BackgroundPhase = "idle" | "removing" | "ready" | "unavailable";
type BackgroundTreatment = "white" | "neutral" | "blur";

const STEP_RANGE = [-2, -1, 0, 1, 2];

function ScissorsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 7.5 12 9M8 16.5l12-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function RetakeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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

function ZoomIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15.5 15.5 21 21M10.5 8v5M8 10.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function backgroundNoticeKey(notice: string | undefined): string {
  switch (notice) {
    case "background_removal_timed_out":
      return "studio.backgroundTimedOutNotice";
    case "background_removal_quota_reached":
      return "studio.backgroundQuotaNotice";
    case "background_removal_unavailable":
      return "studio.backgroundUnavailableNotice";
    default:
      return "studio.backgroundFailedNotice";
  }
}

function previewFilter(brightness: number, contrast: number, sharpen: boolean, autoLighting: boolean): string {
  const brightnessValue = 1 + brightness * 0.08 + (autoLighting ? 0.05 : 0);
  const contrastValue = 1 + contrast * 0.12 + (autoLighting ? 0.05 : 0) + (sharpen ? 0.08 : 0);
  const saturateValue = 1 + (autoLighting || sharpen ? 0.05 : 0);

  const parts: string[] = [];
  if (brightnessValue !== 1) parts.push(`brightness(${brightnessValue})`);
  if (contrastValue !== 1) parts.push(`contrast(${contrastValue})`);
  if (saturateValue !== 1) parts.push(`saturate(${saturateValue})`);
  return parts.join(" ");
}

function aspectForCrop(preset: CropPreset): string | undefined {
  if (preset === "square") return "1 / 1";
  if (preset === "portrait") return "4 / 5";
  return undefined;
}

function fillColorFor(treatment: BackgroundTreatment): string {
  if (treatment === "neutral") return "var(--color-background)";
  return "#ffffff";
}

export function PhotoStudio({ blob, originalUrl, enhancedUrl, onAccept, onRetake }: PhotoStudioProps) {
  const { t } = useLanguage();

  const [bgPhase, setBgPhase] = useState<BackgroundPhase>("idle");
  const [cutoutUrl, setCutoutUrl] = useState<string | null>(null);
  const [backgroundActive, setBackgroundActive] = useState(false);
  const [backgroundTreatment, setBackgroundTreatment] = useState<BackgroundTreatment>("white");
  const [backgroundNotice, setBackgroundNotice] = useState<string | undefined>(undefined);

  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [sharpen, setSharpen] = useState(false);
  const [autoLighting, setAutoLighting] = useState(false);
  const [cropPreset, setCropPreset] = useState<CropPreset>("original");

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeFailed, setFinalizeFailed] = useState(false);
  const [zoomedTile, setZoomedTile] = useState<"original" | "processed" | null>(null);

  const filter = useMemo(
    () => previewFilter(brightness, contrast, sharpen, autoLighting),
    [brightness, contrast, sharpen, autoLighting],
  );
  const aspect = aspectForCrop(cropPreset);

  async function handleRemoveBackground() {
    setBgPhase("removing");
    setBackgroundNotice(undefined);
    try {
      const result = await removeImageBackground(blob);
      if (result.backgroundRemoved && result.cutoutUrl) {
        setCutoutUrl(result.cutoutUrl);
        setBackgroundActive(true);
        setBackgroundTreatment("white");
        setBgPhase("ready");
      } else {
        setBackgroundNotice(result.notice);
        setBgPhase("unavailable");
      }
    } catch {
      setBackgroundNotice(undefined);
      setBgPhase("unavailable");
    }
  }

  function studioOptions(): StudioOptions {
    const backgroundFill: BackgroundFill = backgroundActive
      ? backgroundTreatment === "blur"
        ? "none"
        : backgroundTreatment === "neutral"
          ? "neutral"
          : "white"
      : "none";

    return {
      brightness,
      contrast,
      sharpen,
      autoLighting,
      backgroundBlur: backgroundActive && backgroundTreatment === "blur",
      backgroundFill,
      cropPreset,
    };
  }

  async function handleAccept() {
    setFinalizing(true);
    setFinalizeFailed(false);
    const sourceUrl = backgroundActive && cutoutUrl ? cutoutUrl : enhancedUrl;

    try {
      const result = await finalizeImage(sourceUrl, studioOptions());
      onAccept(result.finalImageUrl);
    } catch {
      setFinalizeFailed(true);
    } finally {
      setFinalizing(false);
    }
  }

  function handleSkipEdits() {
    onAccept(enhancedUrl);
  }

  function renderProcessed(imageClassName: string) {
    return backgroundActive && cutoutUrl ? (
      <div className="studio-composite">
        {backgroundTreatment === "blur" ? (
          <img src={enhancedUrl} alt="" className={`${imageClassName} studio-backdrop-blur`} />
        ) : (
          <div className="studio-backdrop-fill" style={{ background: fillColorFor(backgroundTreatment) }} />
        )}
        <img src={cutoutUrl} alt="" className={`${imageClassName} studio-subject`} style={{ filter }} />
      </div>
    ) : (
      <img src={enhancedUrl} alt="" className={imageClassName} style={{ filter }} />
    );
  }

  return (
    <div className="studio-screen">
      <h1 className="onboarding-title studio-title">{t("studio.title")}</h1>

      <div className="studio-tiles">
        <button
          type="button"
          className="studio-tile studio-tile-button"
          onClick={() => setZoomedTile("original")}
        >
          <img src={originalUrl} alt="" className="studio-tile-image" />
          <span className="studio-tile-label">{t("studio.original")}</span>
          <span className="studio-tile-zoom-hint" aria-hidden="true">
            <ZoomIcon />
          </span>
        </button>

        <button
          type="button"
          className="studio-tile studio-tile-button"
          style={{ aspectRatio: aspect }}
          onClick={() => setZoomedTile("processed")}
        >
          {renderProcessed("studio-tile-image")}
          <span className="studio-tile-label">{t("studio.processed")}</span>
          <span className="studio-tile-zoom-hint" aria-hidden="true">
            <ZoomIcon />
          </span>
        </button>
      </div>

      {zoomedTile && (
        <div className="studio-zoom-overlay" onClick={() => setZoomedTile(null)}>
          <button
            type="button"
            className="studio-zoom-close"
            onClick={() => setZoomedTile(null)}
            aria-label={t("home.detailClose")}
          >
            <CloseIcon />
          </button>
          <div className="studio-zoom-content" onClick={(event) => event.stopPropagation()}>
            {zoomedTile === "original" ? (
              <img src={originalUrl} alt="" className="studio-zoom-image" />
            ) : (
              renderProcessed("studio-zoom-image")
            )}
            <span className="studio-zoom-label">
              {t(zoomedTile === "original" ? "studio.original" : "studio.processed")}
            </span>
          </div>
        </div>
      )}

      <div className="studio-controls">
        <div className="studio-group">
          {bgPhase === "idle" && (
            <button type="button" className="studio-action" onClick={handleRemoveBackground}>
              <ScissorsIcon />
              {t("studio.removeBackground")}
            </button>
          )}

          {bgPhase === "removing" && (
            <button type="button" className="studio-action" disabled>
              <span className="camera-spinner studio-spinner" aria-hidden="true" />
              {t("studio.removingBackground")}
            </button>
          )}

          {bgPhase === "unavailable" && (
            <div className="studio-notice">
              {backgroundNotice && <p className="body-s">{t(backgroundNoticeKey(backgroundNotice))}</p>}
              <button type="button" className="studio-action" onClick={handleRemoveBackground}>
                <ScissorsIcon />
                {t("studio.removeBackground")}
              </button>
            </div>
          )}

          {bgPhase === "ready" && (
            <>
              <button
                type="button"
                className={`studio-action${backgroundActive ? "" : " studio-action-inactive"}`}
                onClick={() => setBackgroundActive((prev) => !prev)}
              >
                <ScissorsIcon />
                {backgroundActive ? t("studio.removeBackground") : t("studio.keepOriginalBackground")}
              </button>

              {backgroundActive && (
                <div className="studio-chip-row">
                  <button
                    type="button"
                    className={`studio-chip${backgroundTreatment === "white" ? " studio-chip-active" : ""}`}
                    onClick={() => setBackgroundTreatment("white")}
                  >
                    {t("studio.backgroundWhite")}
                  </button>
                  <button
                    type="button"
                    className={`studio-chip${backgroundTreatment === "neutral" ? " studio-chip-active" : ""}`}
                    onClick={() => setBackgroundTreatment("neutral")}
                  >
                    {t("studio.backgroundNeutral")}
                  </button>
                  <button
                    type="button"
                    className={`studio-chip${backgroundTreatment === "blur" ? " studio-chip-active" : ""}`}
                    onClick={() => setBackgroundTreatment("blur")}
                  >
                    {t("studio.backgroundBlur")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="studio-group">
          <span className="studio-label">{t("studio.brightness")}</span>
          <div className="studio-stepper">
            <button
              type="button"
              className="studio-step-btn"
              disabled={brightness <= -2}
              onClick={() => setBrightness((v) => Math.max(-2, v - 1))}
              aria-label={t("studio.brightness")}
            >
              <MinusIcon />
            </button>
            <div className="studio-step-dots">
              {STEP_RANGE.map((step) => (
                <span key={step} className={`studio-step-dot${step === brightness ? " studio-step-dot-active" : ""}`} />
              ))}
            </div>
            <button
              type="button"
              className="studio-step-btn"
              disabled={brightness >= 2}
              onClick={() => setBrightness((v) => Math.min(2, v + 1))}
              aria-label={t("studio.brightness")}
            >
              <PlusIcon />
            </button>
          </div>
        </div>

        <div className="studio-group">
          <span className="studio-label">{t("studio.contrast")}</span>
          <div className="studio-stepper">
            <button
              type="button"
              className="studio-step-btn"
              disabled={contrast <= -2}
              onClick={() => setContrast((v) => Math.max(-2, v - 1))}
              aria-label={t("studio.contrast")}
            >
              <MinusIcon />
            </button>
            <div className="studio-step-dots">
              {STEP_RANGE.map((step) => (
                <span key={step} className={`studio-step-dot${step === contrast ? " studio-step-dot-active" : ""}`} />
              ))}
            </div>
            <button
              type="button"
              className="studio-step-btn"
              disabled={contrast >= 2}
              onClick={() => setContrast((v) => Math.min(2, v + 1))}
              aria-label={t("studio.contrast")}
            >
              <PlusIcon />
            </button>
          </div>
        </div>

        <div className="studio-group studio-toggle-row">
          <button
            type="button"
            className={`studio-chip${sharpen ? " studio-chip-active" : ""}`}
            onClick={() => setSharpen((v) => !v)}
          >
            {t("studio.sharpen")}
          </button>
          <button
            type="button"
            className={`studio-chip${autoLighting ? " studio-chip-active" : ""}`}
            onClick={() => setAutoLighting((v) => !v)}
          >
            <SparkleIcon />
            {t("studio.autoLighting")}
          </button>
        </div>

        <div className="studio-group">
          <span className="studio-label">{t("studio.crop")}</span>
          <div className="studio-chip-row">
            <button
              type="button"
              className={`studio-chip${cropPreset === "original" ? " studio-chip-active" : ""}`}
              onClick={() => setCropPreset("original")}
            >
              {t("studio.cropOriginal")}
            </button>
            <button
              type="button"
              className={`studio-chip${cropPreset === "square" ? " studio-chip-active" : ""}`}
              onClick={() => setCropPreset("square")}
            >
              {t("studio.cropSquare")}
            </button>
            <button
              type="button"
              className={`studio-chip${cropPreset === "portrait" ? " studio-chip-active" : ""}`}
              onClick={() => setCropPreset("portrait")}
            >
              {t("studio.cropPortrait")}
            </button>
          </div>
        </div>
      </div>

      {finalizeFailed && (
        <div className="studio-notice">
          <p className="body-s onboarding-error" role="alert">
            {t("camera.enhanceError")}
          </p>
          <Button variant="secondary" onClick={handleSkipEdits}>
            {t("studio.accept")}
          </Button>
        </div>
      )}

      {finalizing && <p className="body-s studio-finalizing-hint">{t("studio.finalizing")}</p>}

      <div className="camera-review-actions studio-actions">
        <Button variant="secondary" icon={<RetakeIcon />} onClick={onRetake} disabled={finalizing}>
          {t("studio.retake")}
        </Button>
        <Button variant="primary" icon={<CheckIcon />} loading={finalizing} onClick={handleAccept}>
          {t("studio.accept")}
        </Button>
      </div>
    </div>
  );
}

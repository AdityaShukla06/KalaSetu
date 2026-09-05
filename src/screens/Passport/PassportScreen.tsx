import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { getPublicPassport } from "../../services/api";
import type { PublicPassport } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Passport.css";

type LoadState = "loading" | "not-found" | "error" | "loaded";

export function PassportScreen() {
  const { passportId } = useParams<{ passportId: string }>();
  const { language, t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [passport, setPassport] = useState<PublicPassport | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    document.documentElement.style.setProperty("--shell-max-width", "none");
    return () => {
      document.documentElement.style.removeProperty("--shell-max-width");
    };
  }, []);

  useEffect(() => {
    if (!passportId) return;
    let cancelled = false;
    setState("loading");

    getPublicPassport(passportId)
      .then((result) => {
        if (cancelled) return;
        setPassport(result);
        setState("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        setState(err instanceof Error && err.message.includes("404") ? "not-found" : "error");
      });

    return () => {
      cancelled = true;
    };
  }, [passportId]);

  useEffect(() => {
    if (!passportId) return;
    const url = `${window.location.origin}/passport/${passportId}`;
    let cancelled = false;

    QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#1e2a44", light: "#ffffff" } })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [passportId]);

  async function handleShare() {
    const url = window.location.href;
    const shareData = {
      title: passport ? `${passport.titleEn}, Craft Heritage Passport` : "Craft Heritage Passport",
      text: passport ? `${passport.passportId}: ${passport.titleEn}` : undefined,
      url,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      return;
    }
  }

  function handlePrint() {
    window.print();
  }

  if (state === "loading") {
    return (
      <div className="passport-page">
        <div className="passport-card">
          <Skeleton height="360px" />
        </div>
      </div>
    );
  }

  if (state === "not-found") {
    return (
      <div className="passport-page passport-page-center">
        <h1>{t("passport.notFoundTitle")}</h1>
        <p className="body-s">{t("passport.notFoundMessage")}</p>
      </div>
    );
  }

  if (state === "error" || !passport) {
    return (
      <div className="passport-page passport-page-center">
        <p className="body-s">{t("passport.loadError")}</p>
      </div>
    );
  }

  const title = language === passport.localLanguage ? passport.titleLocal : passport.titleEn;
  const createdDate = new Date(passport.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="passport-page">
      <div className="passport-actions no-print">
        <Button variant="secondary" onClick={handleShare}>
          {shareCopied ? t("passport.shareCopied") : t("passport.shareButton")}
        </Button>
        <Button variant="secondary" onClick={handlePrint}>
          {t("passport.printButton")}
        </Button>
      </div>

      <article className="passport-card">
        <header className="passport-header">
          <span className="passport-eyebrow">{t("passport.eyebrow")}</span>
          <h1 className="passport-product-id">{passport.passportId}</h1>
        </header>

        <div className="passport-body">
          <div className="passport-image-wrap">
            <img src={passport.imageUrl} alt="" className="passport-image" />
          </div>

          <div className="passport-details">
            <h2 className="passport-title">{title}</h2>

            <dl className="passport-fields">
              <div className="passport-field">
                <dt>{t("passport.artisanLabel")}</dt>
                <dd>{passport.artisanName ?? "—"}</dd>
              </div>

              {passport.region && (
                <div className="passport-field">
                  <dt>{t("passport.regionLabel")}</dt>
                  <dd>{passport.region}</dd>
                </div>
              )}

              <div className="passport-field">
                <dt>{t("passport.craftTypeLabel")}</dt>
                <dd>{passport.category}</dd>
              </div>

              {passport.technique && (
                <div className="passport-field">
                  <dt>{t("passport.techniqueLabel")}</dt>
                  <dd>{passport.technique}</dd>
                </div>
              )}

              {passport.material && (
                <div className="passport-field">
                  <dt>{t("passport.materialsLabel")}</dt>
                  <dd>{passport.material}</dd>
                </div>
              )}

              {passport.timeTaken && (
                <div className="passport-field">
                  <dt>{t("passport.timeTakenLabel")}</dt>
                  <dd>{passport.timeTaken}</dd>
                </div>
              )}

              <div className="passport-field">
                <dt>{t("passport.createdLabel")}</dt>
                <dd>{createdDate}</dd>
              </div>

              {passport.giTag && (
                <div className="passport-field passport-field-highlight">
                  <dt>{t("passport.giTagLabel")}</dt>
                  <dd>{passport.giTag}</dd>
                </div>
              )}
            </dl>

            {passport.careInstructions && (
              <div className="passport-care">
                <p className="caption">{t("passport.careLabel")}</p>
                <p className="body-s">{passport.careInstructions}</p>
              </div>
            )}
          </div>

          <div className="passport-qr-wrap">
            {qrDataUrl && <img src={qrDataUrl} alt="" className="passport-qr" width={120} height={120} />}
            <p className="caption passport-qr-hint">{t("passport.scanHint")}</p>
          </div>
        </div>

        <div className="passport-story">
          <h3>{t("passport.storyTitle")}</h3>
          <p className="body-s passport-story-text">
            {passport.productStory ?? t("passport.storyUnavailable")}
          </p>
        </div>

        <footer className="passport-footer">
          <p className="caption passport-footer-text">{t("passport.selfDeclaredNotice")}</p>
        </footer>
      </article>
    </div>
  );
}

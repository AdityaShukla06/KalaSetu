import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { getAnalyticsSummary } from "../../services/api";
import type { AnalyticsSummary, AnalyticsListingStat } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Analytics.css";

type LoadState = "loading" | "error" | "loaded";
type SortKey = "views" | "inquiries";

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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

function ViewsChart({ points }: { points: AnalyticsSummary["viewsOverTime"] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const width = Math.max(360, points.length * 14);
  const height = 120;

  const stepX = width / Math.max(1, points.length - 1);
  const coords = points.map((point, index) => {
    const x = index * stepX;
    const y = height - (point.count / max) * height;
    return { x, y, point };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");

  return (
    <div className="analytics-chart-scroll">
      <svg width={width} height={height + 24} role="img" aria-label="Views over the last 30 days">
        <path d={linePath} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {coords.map(({ x, y, point }, index) => (
          <g key={point.date}>
            <circle cx={x} cy={y} r={2.5} fill="var(--color-primary)" />
            {index % 5 === 0 && (
              <text x={x} y={height + 16} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">
                {point.date.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function AnalyticsScreen() {
  const { t } = useLanguage();
  const [state, setState] = useState<LoadState>("loading");
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("views");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await getAnalyticsSummary();
      setSummary(result);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const hasAnyViews = (summary?.viewsOverTime ?? []).some((point) => point.count > 0);
  const sortedListings: AnalyticsListingStat[] = summary
    ? [...summary.listings].sort((a, b) =>
        sortKey === "views" ? b.viewCount - a.viewCount : b.inquiryCount - a.inquiryCount,
      )
    : [];

  return (
    <div className="screen analytics-screen">
      <Link to="/" className="analytics-back">
        <BackIcon />
        {t("analytics.backToShop")}
      </Link>

      <h1>{t("analytics.title")}</h1>

      {state === "loading" && (
        <div className="stat-card-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="stat-card" key={i}>
              <Skeleton height="14px" width="60%" />
              <Skeleton height="28px" width="40%" />
            </div>
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="analytics-state">
          <p className="body-s">{t("analytics.loadError")}</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            {t("pricing.retry")}
          </Button>
        </div>
      )}

      {state === "loaded" && summary && (
        <>
          <div className="stat-card-grid">
            <div className="stat-card">
              <span className="stat-card-label">{t("analytics.totalViews")}</span>
              <span className="stat-card-value">{summary.totalViews}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">{t("analytics.viewsThisWeek")}</span>
              <span className="stat-card-value">{summary.viewsThisWeek}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">{t("analytics.totalInquiries")}</span>
              <span className="stat-card-value">{summary.totalInquiries}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">{t("analytics.activeListings")}</span>
              <span className="stat-card-value">{summary.activeListings}</span>
            </div>
          </div>

          <div className="analytics-section">
            <h3>{t("analytics.chartTitle")}</h3>
            {hasAnyViews ? (
              <ViewsChart points={summary.viewsOverTime} />
            ) : (
              <div className="analytics-empty">
                <p className="body-s">{t("analytics.chartEmpty")}</p>
              </div>
            )}
          </div>

          <div className="analytics-section">
            <h3>{t("analytics.topListingsTitle")}</h3>

            {sortedListings.length === 0 ? (
              <div className="analytics-empty">
                <p className="body-s">{t("analytics.listingsEmpty")}</p>
              </div>
            ) : (
              <>
                <p className="caption analytics-window-note">{t("analytics.windowNote")}</p>
                <div className="analytics-table-wrap">
                  <table className="analytics-table">
                    <thead>
                      <tr>
                        <th>{t("analytics.columnTitle")}</th>
                        <th>
                          <button
                            type="button"
                            className={`analytics-sort-button${sortKey === "views" ? " analytics-sort-active" : ""}`}
                            onClick={() => setSortKey("views")}
                          >
                            {t("analytics.columnViews")}
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className={`analytics-sort-button${sortKey === "inquiries" ? " analytics-sort-active" : ""}`}
                            onClick={() => setSortKey("inquiries")}
                          >
                            {t("analytics.columnInquiries")}
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedListings.map((listing) => (
                        <tr key={listing.productId}>
                          <td>{listing.titleEn}</td>
                          <td>{listing.viewCount}</td>
                          <td>{listing.inquiryCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

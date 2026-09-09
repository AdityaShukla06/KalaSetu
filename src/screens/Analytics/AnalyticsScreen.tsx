import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
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

const PLOT_HEIGHT = 130;
const MARGIN_TOP = 14;
const MARGIN_RIGHT = 12;
const MARGIN_BOTTOM = 44;
const MAX_X_LABELS = 5;
const MIN_LABEL_GAP = 70;
const DOT_LIMIT = 14;

function buildYTicks(maxValue: number): number[] {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const step = steps.find((candidate) => maxValue / candidate <= 4) ?? Math.ceil(maxValue / 4);
  const top = Math.max(step, Math.ceil(maxValue / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

function parseDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function makeDateFormatter(language: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(language, options);
  } catch {
    return new Intl.DateTimeFormat(undefined, options);
  }
}

function pickLabelIndices(count: number, plotWidth: number): number[] {
  const stepX = plotWidth / Math.max(1, count - 1);
  const maxLabels = Math.max(2, Math.min(MAX_X_LABELS, Math.floor(plotWidth / MIN_LABEL_GAP) + 1));
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);

  const spacing = (count - 1) / (maxLabels - 1);
  const kept: number[] = [];
  for (let slot = 0; slot < maxLabels; slot += 1) {
    const index = Math.round(slot * spacing);
    const previous = kept[kept.length - 1];
    if (previous === undefined || (index - previous) * stepX >= MIN_LABEL_GAP) {
      kept.push(index);
    } else if (index === count - 1) {
      kept[kept.length - 1] = index;
    }
  }
  return kept;
}

function useMeasuredWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setWidth(Math.round(node.clientWidth) || fallback);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fallback]);
  return { ref, width };
}

function ViewsChart({ points }: { points: AnalyticsSummary["viewsOverTime"] }) {
  const { t, language } = useLanguage();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { ref: plotRef, width } = useMeasuredWidth(260);

  const shortDate = useMemo(() => makeDateFormatter(language, { day: "numeric", month: "short" }), [language]);
  const longDate = useMemo(
    () => makeDateFormatter(language, { weekday: "short", day: "numeric", month: "long" }),
    [language],
  );

  const yTicks = buildYTicks(Math.max(1, ...points.map((point) => point.count)));
  const yMax = yTicks[yTicks.length - 1];

  const marginLeft = 24 + String(yMax).length * 8;
  const plotWidth = Math.max(120, width - marginLeft - MARGIN_RIGHT);
  const height = PLOT_HEIGHT + MARGIN_TOP + MARGIN_BOTTOM;
  const baselineY = MARGIN_TOP + PLOT_HEIGHT;

  const stepX = plotWidth / Math.max(1, points.length - 1);
  const coords = points.map((point, index) => ({
    x: marginLeft + index * stepX,
    y: baselineY - (point.count / yMax) * PLOT_HEIGHT,
    point,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const lastX = coords[coords.length - 1].x.toFixed(1);
  const areaPath = `${linePath} L ${lastX} ${baselineY} L ${coords[0].x.toFixed(1)} ${baselineY} Z`;

  const peakIndex = coords.reduce((best, current, index) => (current.point.count > coords[best].point.count ? index : best), 0);
  const peak = coords[peakIndex];
  const totalViews = points.reduce((sum, point) => sum + point.count, 0);
  const activeCoord = activeIndex === null ? null : coords[activeIndex];
  const readout = activeCoord ?? peak;

  function moveTo(index: number) {
    setActiveIndex(Math.min(points.length - 1, Math.max(0, index)));
  }

  function handlePointer(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const localX = ((event.clientX - rect.left) * width) / rect.width - marginLeft;
    moveTo(Math.round(localX / stepX));
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = activeIndex ?? peakIndex;
    moveTo(event.key === "ArrowLeft" ? current - 1 : current + 1);
  }

  return (
    <div className="analytics-chart">
      <p className="analytics-chart-readout">
        <span className="analytics-chart-readout-value">{readout.point.count}</span>
        <span className="analytics-chart-readout-label">{t("analytics.chartYAxis")}</span>
        <span className="analytics-chart-readout-date">{longDate.format(parseDay(readout.point.date))}</span>
      </p>

      <div className="analytics-chart-plot" ref={plotRef}>
        <svg
          width={width}
          height={height}
          tabIndex={0}
          role="img"
          aria-label={t("analytics.chartAria", {
            total: totalViews,
            date: longDate.format(parseDay(peak.point.date)),
            peak: peak.point.count,
          })}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
          onFocus={() => setActiveIndex(peakIndex)}
          onBlur={() => setActiveIndex(null)}
          onKeyDown={handleKeyDown}
        >
          {yTicks.map((tick) => {
            const y = baselineY - (tick / yMax) * PLOT_HEIGHT;
            return (
              <g key={tick}>
                <line x1={marginLeft} y1={y} x2={marginLeft + plotWidth} y2={y} stroke="var(--color-border)" strokeWidth={1} />
                <text x={marginLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--color-text-muted)">
                  {tick}
                </text>
              </g>
            );
          })}

          <path d={areaPath} fill="var(--color-primary)" fillOpacity={0.12} />
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {pickLabelIndices(points.length, plotWidth).map((index) => (
            <text
              key={coords[index].point.date}
              x={coords[index].x}
              y={baselineY + 18}
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
              fontSize="11"
              fill="var(--color-text-muted)"
            >
              {shortDate.format(parseDay(coords[index].point.date))}
            </text>
          ))}

          {points.length <= DOT_LIMIT &&
            coords.map((coord) => (
              <circle
                key={coord.point.date}
                cx={coord.x}
                cy={coord.y}
                r={4}
                fill="var(--color-primary)"
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
            ))}

          <circle cx={peak.x} cy={peak.y} r={4} fill="var(--color-primary)" stroke="var(--color-surface)" strokeWidth={2} />
          <text
            x={Math.min(Math.max(peak.x, marginLeft + 10), marginLeft + plotWidth - 10)}
            y={Math.max(peak.y - 10, 11)}
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            fill="var(--color-secondary)"
          >
            {peak.point.count}
          </text>

          {activeCoord && (
            <>
              <line
                x1={activeCoord.x}
                y1={MARGIN_TOP}
                x2={activeCoord.x}
                y2={baselineY}
                stroke="var(--color-primary)"
                strokeWidth={1}
                strokeOpacity={0.5}
              />
              <circle
                cx={activeCoord.x}
                cy={activeCoord.y}
                r={5}
                fill="var(--color-primary)"
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
            </>
          )}

          <line x1={marginLeft} y1={baselineY} x2={marginLeft + plotWidth} y2={baselineY} stroke="var(--color-text-muted)" strokeWidth={1} />
          <text
            x={marginLeft + plotWidth / 2}
            y={height - 5}
            textAnchor="middle"
            fontSize="11"
            fontWeight="600"
            fill="var(--color-text-muted)"
          >
            {t("analytics.chartXAxis")}
          </text>
          <text
            x={10}
            y={MARGIN_TOP + PLOT_HEIGHT / 2}
            textAnchor="middle"
            fontSize="11"
            fontWeight="600"
            fill="var(--color-text-muted)"
            transform={`rotate(-90 10 ${MARGIN_TOP + PLOT_HEIGHT / 2})`}
          >
            {t("analytics.chartYAxis")}
          </text>
        </svg>
      </div>

      <p className="caption analytics-chart-note">{t("analytics.chartHint")}</p>
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

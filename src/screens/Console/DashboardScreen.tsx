import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { getDashboardStats, getAuditLog } from "../../services/api";
import type { DashboardStats, AuditLogEntry } from "../../services/api";
import "./ConsoleLayout.css";
import "./Dashboard.css";

type LoadState = "loading" | "error" | "loaded";

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SignupChart({ points }: { points: DashboardStats["signupsOverTime"] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const width = Math.max(360, points.length * 18);
  const height = 140;
  const barWidth = (width / points.length) * 0.6;

  return (
    <div className="signup-chart-scroll">
      <svg width={width} height={height + 24} role="img" aria-label="Signups over the last 30 days">
        {points.map((point, index) => {
          const barHeight = (point.count / max) * height;
          const x = (width / points.length) * index + (width / points.length - barWidth) / 2;
          const y = height - barHeight;
          return (
            <g key={point.date}>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx={2} fill="var(--color-primary)" opacity={point.count > 0 ? 1 : 0.15} />
              {index % 5 === 0 && (
                <text x={x + barWidth / 2} y={height + 16} textAnchor="middle" fontSize="10" fill="var(--color-text-muted)">
                  {point.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function DashboardScreen() {
  const [state, setState] = useState<LoadState>("loading");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activity, setActivity] = useState<AuditLogEntry[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [statsResult, activityResult] = await Promise.all([getDashboardStats(), getAuditLog(15)]);
      setStats(statsResult);
      setActivity(activityResult);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="console-page-header">
        <h1>Dashboard</h1>
      </div>

      {state === "loading" && (
        <div className="stat-card-grid">
          {Array.from({ length: 5 }).map((_, i) => (
            <div className="stat-card" key={i}>
              <Skeleton height="14px" width="60%" />
              <Skeleton height="28px" width="40%" />
            </div>
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="console-error">
          <p>Could not load the dashboard.</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state === "loaded" && stats && (
        <>
          <div className="stat-card-grid">
            <div className="stat-card">
              <span className="stat-card-label">Total artisans</span>
              <span className="stat-card-value">{stats.totalArtisans}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">Total buyers</span>
              <span className="stat-card-value">{stats.totalBuyers}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">Total products</span>
              <span className="stat-card-value">{stats.totalProducts}</span>
            </div>
            <div className="stat-card stat-card-highlight">
              <span className="stat-card-label">Pending approval</span>
              <span className="stat-card-value">{stats.pendingApproval}</span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label">Total inquiries</span>
              <span className="stat-card-value">{stats.totalInquiries}</span>
            </div>
          </div>

          <div className="dashboard-section">
            <h3>Signups, last 30 days</h3>
            <SignupChart points={stats.signupsOverTime} />
          </div>

          <div className="dashboard-section">
            <h3>Recent admin activity</h3>
            {activity.length === 0 ? (
              <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
                No moderation actions recorded yet.
              </p>
            ) : (
              <div className="console-table-wrap">
                <table className="console-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Admin</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.createdAt).toLocaleString()}</td>
                        <td>{entry.actorEmail ?? "—"}</td>
                        <td>{entry.action}</td>
                        <td>
                          {entry.targetTable}/{entry.targetId.slice(0, 8)}
                        </td>
                        <td>{entry.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

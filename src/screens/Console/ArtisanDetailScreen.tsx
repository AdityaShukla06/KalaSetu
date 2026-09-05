import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { getArtisanDetail, setArtisanActive } from "../../services/api";
import type { ConsoleArtisanDetail } from "../../services/api";
import "./ConsoleLayout.css";
import "./ArtisanDetail.css";

type LoadState = "loading" | "error" | "not-found" | "loaded";

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const REVIEW_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  flagged: "Flagged",
};

export function ArtisanDetailScreen() {
  const { artisanId } = useParams<{ artisanId: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [artisan, setArtisan] = useState<ConsoleArtisanDetail | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!artisanId) return;
    setState("loading");
    try {
      const result = await getArtisanDetail(artisanId);
      setArtisan(result);
      setState("loaded");
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        setState("not-found");
      } else {
        setState("error");
      }
    }
  }, [artisanId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleActive(reason?: string) {
    if (!artisan) return;
    setBusy(true);
    try {
      await setArtisanActive(artisan.userId, !artisan.isActive, reason);
      setConfirmOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return (
      <div>
        <Skeleton height="24px" width="240px" />
        <div style={{ marginTop: "16px" }}>
          <Skeleton height="120px" />
        </div>
      </div>
    );
  }

  if (state === "not-found") {
    return (
      <div className="console-empty">
        <p>Artisan not found.</p>
        <Link to="/internal/console/artisans">Back to artisans</Link>
      </div>
    );
  }

  if (state === "error" || !artisan) {
    return (
      <div className="console-error">
        <p>Could not load this artisan.</p>
        <Button variant="primary" icon={<RetryIcon />} onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Link to="/internal/console/artisans" className="artisan-detail-back">
        ← Back to artisans
      </Link>

      <div className="console-page-header">
        <div>
          <h1>{artisan.displayName ?? artisan.email}</h1>
          <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
            {artisan.shopName ?? "No shop name"} · {artisan.region ?? "No region"} · {artisan.email}
          </p>
        </div>
        <Button variant={artisan.isActive ? "destructive" : "primary"} onClick={() => setConfirmOpen(true)}>
          {artisan.isActive ? "Deactivate artisan" : "Reactivate artisan"}
        </Button>
      </div>

      <span className={`console-badge console-badge-${artisan.isActive ? "active" : "inactive"}`}>
        {artisan.isActive ? "Active" : "Deactivated"}
      </span>

      <div className="dashboard-section" style={{ marginTop: "24px" }}>
        <h3>Listings ({artisan.listings.length})</h3>
        {artisan.listings.length === 0 ? (
          <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
            No listings yet.
          </p>
        ) : (
          <div className="console-table-wrap">
            <table className="console-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Status</th>
                  <th>Review</th>
                  <th>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {artisan.listings.map((listing) => (
                  <tr key={listing.productId}>
                    <td>{listing.titleEn}</td>
                    <td>{listing.category}</td>
                    <td>₹{listing.price}</td>
                    <td>{listing.status}</td>
                    <td>
                      <span className={`console-badge console-badge-${listing.reviewStatus}`}>
                        {REVIEW_LABEL[listing.reviewStatus] ?? listing.reviewStatus}
                      </span>
                    </td>
                    <td>{listing.flagged ? listing.flagReason ?? "Yes" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={artisan.isActive ? "Deactivate this artisan?" : "Reactivate this artisan?"}
          message={
            artisan.isActive
              ? "They will no longer be able to sign in. Their existing listings are not removed."
              : "They will be able to sign in again."
          }
          confirmLabel={artisan.isActive ? "Deactivate" : "Reactivate"}
          cancelLabel="Cancel"
          destructive={artisan.isActive}
          requireReason={artisan.isActive}
          reasonLabel="Reason (recorded in the audit log)"
          busy={busy}
          onConfirm={handleToggleActive}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

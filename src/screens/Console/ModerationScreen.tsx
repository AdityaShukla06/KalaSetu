import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { getModerationQueue, approveListing, rejectListing, flagListing } from "../../services/api";
import type { Product } from "../../services/api";
import "./ConsoleLayout.css";

type LoadState = "loading" | "error" | "loaded";
type DialogKind = "reject" | "flag" | null;
const PAGE_SIZE = 20;

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ModerationScreen() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: DialogKind; product: Product | null }>({ kind: null, product: null });

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await getModerationQueue(page, PAGE_SIZE);
      setItems(result.items);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApprove(product: Product) {
    setBusyId(product.productId);
    try {
      await approveListing(product.productId);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDialogConfirm(reason?: string) {
    if (!dialog.product || !reason) return;
    setBusyId(dialog.product.productId);
    try {
      if (dialog.kind === "reject") await rejectListing(dialog.product.productId, reason);
      if (dialog.kind === "flag") await flagListing(dialog.product.productId, reason);
      setDialog({ kind: null, product: null });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="console-page-header">
        <h1>Listing moderation</h1>
      </div>

      {state === "loading" && (
        <div className="console-table-wrap">
          <table className="console-table">
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={5}>
                    <Skeleton height="20px" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state === "error" && (
        <div className="console-error">
          <p>Could not load the moderation queue.</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state === "loaded" && items.length === 0 && (
        <div className="console-empty">
          <p>Nothing pending review. New listings will appear here as they're published.</p>
        </div>
      )}

      {state === "loaded" && items.length > 0 && (
        <>
          <div className="console-table-wrap">
            <table className="console-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Artisan</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.titleEn}</td>
                    <td>{product.artisanName ?? "—"}</td>
                    <td>{product.category}</td>
                    <td>₹{product.price}</td>
                    <td>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <Button
                          variant="primary"
                          loading={busyId === product.productId}
                          onClick={() => handleApprove(product)}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busyId === product.productId}
                          onClick={() => setDialog({ kind: "reject", product })}
                        >
                          Reject
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={busyId === product.productId}
                          onClick={() => setDialog({ kind: "flag", product })}
                        >
                          Flag
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="console-pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="body-s">
              Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} ({total} total)
            </span>
            <button type="button" disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}

      {dialog.kind && dialog.product && (
        <ConfirmDialog
          title={dialog.kind === "reject" ? "Reject this listing?" : "Flag this listing?"}
          message={
            dialog.kind === "reject"
              ? "The listing is pulled from the marketplace and returned to draft. The artisan keeps the listing and can be told why."
              : "The listing is pulled from the marketplace immediately."
          }
          confirmLabel={dialog.kind === "reject" ? "Reject" : "Flag"}
          cancelLabel="Cancel"
          destructive
          requireReason
          reasonLabel="Reason (shown in the audit log, required)"
          busy={busyId === dialog.product.productId}
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog({ kind: null, product: null })}
        />
      )}
    </div>
  );
}

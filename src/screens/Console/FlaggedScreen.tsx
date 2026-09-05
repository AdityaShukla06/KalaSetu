import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { getFlaggedListings } from "../../services/api";
import type { FlaggedListing } from "../../services/api";
import "./ConsoleLayout.css";

type LoadState = "loading" | "error" | "loaded";

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FlaggedScreen() {
  const [state, setState] = useState<LoadState>("loading");
  const [available, setAvailable] = useState(true);
  const [items, setItems] = useState<FlaggedListing[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await getFlaggedListings();
      setAvailable(result.available);
      setItems(result.items);
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
        <h1>Flagged listings</h1>
      </div>

      {state === "loading" && <Skeleton height="120px" />}

      {state === "error" && (
        <div className="console-error">
          <p>Could not load flagged listings.</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state === "loaded" && !available && (
        <div className="console-empty">
          <p>
            Automatic overcharge flagging isn't enabled yet. This screen will populate once the pricing
            overcharge check is live.
          </p>
        </div>
      )}

      {state === "loaded" && available && items.length === 0 && (
        <div className="console-empty">
          <p>No listings have been auto-flagged.</p>
        </div>
      )}

      {state === "loaded" && available && items.length > 0 && (
        <div className="console-table-wrap">
          <table className="console-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Artisan</th>
                <th>Price</th>
                <th>Auto-flag reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.productId}>
                  <td>{item.titleEn}</td>
                  <td>{item.artisanName ?? "—"}</td>
                  <td>₹{item.price}</td>
                  <td>{item.autoFlagReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

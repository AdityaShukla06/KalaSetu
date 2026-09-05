import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { listArtisans } from "../../services/api";
import type { ConsoleArtisan } from "../../services/api";
import "./ConsoleLayout.css";

type LoadState = "loading" | "error" | "loaded";
const PAGE_SIZE = 20;

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArtisansScreen() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<ConsoleArtisan[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await listArtisans(q, page, PAGE_SIZE);
      setItems(result.items);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, [q, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setQ(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  return (
    <div>
      <div className="console-page-header">
        <h1>Artisans</h1>
        <input
          type="search"
          placeholder="Search by name, shop, or email"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          className="console-search-input"
        />
      </div>

      {state === "loading" && (
        <div className="console-table-wrap">
          <table className="console-table">
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={6}>
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
          <p>Could not load artisans.</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state === "loaded" && items.length === 0 && (
        <div className="console-empty">
          <p>{q ? `No artisans match "${q}".` : "No artisans have signed up yet."}</p>
        </div>
      )}

      {state === "loaded" && items.length > 0 && (
        <>
          <div className="console-table-wrap">
            <table className="console-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Shop</th>
                  <th>Email</th>
                  <th>Region</th>
                  <th>Products</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((artisan) => (
                  <tr
                    key={artisan.userId}
                    onClick={() => navigate(`/internal/console/artisans/${artisan.userId}`)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{artisan.displayName ?? "—"}</td>
                    <td>{artisan.shopName ?? "—"}</td>
                    <td>{artisan.email}</td>
                    <td>{artisan.region ?? "—"}</td>
                    <td>{artisan.totalProducts}</td>
                    <td>
                      <span className={`console-badge console-badge-${artisan.isActive ? "active" : "inactive"}`}>
                        {artisan.isActive ? "Active" : "Deactivated"}
                      </span>
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
    </div>
  );
}

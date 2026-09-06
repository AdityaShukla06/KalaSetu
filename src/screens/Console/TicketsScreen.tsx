import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Skeleton } from "../../components/Skeleton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { getTickets, resolveTicket, setArtisanActive } from "../../services/api";
import type { SupportTicket, TicketStatus } from "../../services/api";
import "./ConsoleLayout.css";

type LoadState = "loading" | "error" | "loaded";

const TICKET_TYPE_LABEL: Record<SupportTicket["ticketType"], string> = {
  deactivation: "Account deactivated",
  product_removal: "Listing removed",
};

function RetryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TicketsScreen() {
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "all">("open");
  const [state, setState] = useState<LoadState>("loading");
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<SupportTicket | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await getTickets(statusFilter);
      setTickets(result);
      setState("loaded");
    } catch {
      setState("error");
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleResolve(ticketId: string) {
    setBusyId(ticketId);
    try {
      await resolveTicket(ticketId);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(reason?: string) {
    if (!reactivateTarget || !reason) return;
    setBusyId(reactivateTarget.ticketId);
    try {
      await setArtisanActive(reactivateTarget.artisanId, true, reason);
      setReactivateTarget(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="console-page-header">
        <h1>Support tickets</h1>
        <select
          className="console-select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as TicketStatus | "all")}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>

      {state === "loading" && (
        <div className="console-table-wrap">
          <table className="console-table">
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
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
          <p>Could not load tickets.</p>
          <Button variant="primary" icon={<RetryIcon />} onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {state === "loaded" && tickets.length === 0 && (
        <div className="console-empty">
          <p>No {statusFilter === "all" ? "" : statusFilter} tickets right now.</p>
        </div>
      )}

      {state === "loaded" && tickets.length > 0 && (
        <div className="console-table-wrap">
          <table className="console-table">
            <thead>
              <tr>
                <th>Artisan</th>
                <th>Type</th>
                <th>Context</th>
                <th>Message</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.ticketId}>
                  <td>{ticket.artisanDisplayName ?? ticket.artisanEmail}</td>
                  <td>{TICKET_TYPE_LABEL[ticket.ticketType]}</td>
                  <td>{ticket.context ?? "—"}</td>
                  <td>{ticket.message}</td>
                  <td>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {ticket.ticketType === "deactivation" && !ticket.artisanIsActive && (
                        <Button
                          variant="primary"
                          disabled={busyId === ticket.ticketId}
                          onClick={() => setReactivateTarget(ticket)}
                        >
                          Reactivate artisan
                        </Button>
                      )}
                      {ticket.status === "open" && (
                        <Button
                          variant="secondary"
                          loading={busyId === ticket.ticketId}
                          onClick={() => handleResolve(ticket.ticketId)}
                        >
                          Mark resolved
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reactivateTarget && (
        <ConfirmDialog
          title="Reactivate this artisan?"
          message={`${reactivateTarget.artisanDisplayName ?? reactivateTarget.artisanEmail} will be able to sign in again.`}
          confirmLabel="Reactivate"
          cancelLabel="Cancel"
          requireReason
          reasonLabel="Reason (recorded in the audit log)"
          busy={busyId === reactivateTarget.ticketId}
          onConfirm={handleReactivate}
          onCancel={() => setReactivateTarget(null)}
        />
      )}
    </div>
  );
}

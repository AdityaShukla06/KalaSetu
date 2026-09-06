import { apiFetch } from "./_helpers";

export interface TicketPreview {
  ticketType: "deactivation" | "product_removal";
  title: string;
  context: string | null;
}

export function getTicketPreview(token: string): Promise<TicketPreview> {
  return apiFetch(`/tickets/preview?token=${encodeURIComponent(token)}`, { method: "GET" });
}

export function raiseTicket(token: string, message: string): Promise<{ ticketId: string }> {
  return apiFetch("/tickets", {
    method: "POST",
    body: JSON.stringify({ token, message }),
  });
}

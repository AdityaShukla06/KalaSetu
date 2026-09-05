import { getSupabase } from "./supabase";

export interface RecordAuditOptions {
  reason?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  actorId: string,
  action: string,
  targetTable: string,
  targetId: string,
  options: RecordAuditOptions = {},
): Promise<void> {
  const { error } = await getSupabase().from("audit_log").insert({
    actor_id: actorId,
    action,
    target_table: targetTable,
    target_id: targetId,
    reason: options.reason ?? null,
    metadata: options.metadata ?? null,
  });

  if (error) {
    console.error("[audit] could not record audit row", { action, targetTable, targetId, message: error.message });
  }
}

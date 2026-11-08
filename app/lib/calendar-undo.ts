// Undo a Calendar save (staff unavailability or schedule closure) that lost a race or could not be
// verified. No imports: the Calendar calls are passed in, so the decision logic is tested directly.

export type UndoOutcome = "undone" | "changed" | "uncertain" | "failed";

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;

/**
 * editing: restore() writes the previous values back, guarded by the etag of our own write, so a
 *   412 on the first try means someone edited the event after us: their save is newer and runs its
 *   own check, so we leave it ("changed"). Any other failure is retried once. A 412 on the retry is
 *   ambiguous (our first restore may have landed with its response lost), so it is "uncertain".
 * creating: remove() each new id; 404/410 means it is already gone. Failures are retried once.
 */
export async function undoCalendarWrite(options: {
  editing: boolean;
  writtenIds: readonly string[];
  restore: () => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
}): Promise<UndoOutcome> {
  if (options.writtenIds.length === 0) return "undone";
  if (options.editing) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.restore();
        return "undone";
      } catch (error) {
        if (statusOf(error) === 412) return attempt === 0 ? "changed" : "uncertain";
      }
    }
    return "failed";
  }
  let pending = [...options.writtenIds];
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
    const results = await Promise.allSettled(pending.map((id) => options.remove(id)));
    pending = pending.filter((_, index) => {
      const result = results[index];
      if (result.status === "fulfilled") return false;
      const status = statusOf(result.reason);
      return status !== 404 && status !== 410;
    });
  }
  return pending.length === 0 ? "undone" : "failed";
}

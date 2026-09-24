import type { Monitor } from "./api";

// most alarming first: a vanished contract needs attention, one you muted yourself does not
const GROUPS: [string | null, string][] = [
  ["unknown-contract", "Unknown contract"],
  ["expired", "Expired"],
  ["manual", "Muted by you"],
  [null, "Reason not recorded"],
];

/** Days before the sweep deletes an expired monitor — the only auto-delete in the system,
 *  and one that otherwise gives no on-screen warning. */
function retentionNote(strikeDate: string, retentionDays: number): string {
  const days = Math.floor((Date.now() - Date.parse(strikeDate)) / 86_400_000);
  const left = retentionDays + 1 - days;
  if (left <= 0) return "auto-deletes on the next sweep";
  return `auto-deletes in ${left} day${left === 1 ? "" : "s"}`;
}

export function MutedTables({
  monitors, retentionDays, onUnmute, onDelete,
}: {
  monitors: Monitor[];
  retentionDays: number;
  onUnmute: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const muted = monitors.filter((m) => !m.enabled);
  if (muted.length === 0) return null;

  return (
    <>
      {GROUPS.map(([reason, label]) => {
        const rows = muted.filter((m) => (m.disabled_reason ?? null) === reason);
        if (rows.length === 0) return null;
        return (
          <div key={label}>
            <h3>{label}</h3>
            <table>
              <thead>
                <tr>
                  <th className="left">contract</th><th>field</th><th>thr</th>
                  <th className="left">actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className="left">
                      {m.code}
                      {reason === "expired" ? (
                        <div className="legs">{retentionNote(m.strike_date, retentionDays)}</div>
                      ) : null}
                    </td>
                    <td>{m.field}</td>
                    <td>{m.threshold}</td>
                    <td className="left">
                      <button onClick={() => onUnmute(m.id)}>unmute</button>
                      <button onClick={() => onDelete(m.id)}>delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

import { APPROVAL_OPTIONS, type Approval } from "@midna/protocol";
import { useCallback, useEffect, useState } from "react";
import { answerHere, handsApprovals, onHands } from "./host";
import { Mark } from "./ui";

/**
 * The panel at the top of the display when midna wants to do something on
 * this computer that needs a yes. The same question is in the chat and on
 * Telegram; the first answer anywhere wins, and none in time is no.
 */
export function ApprovalPanel() {
  const [pending, setPending] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback(() => void handsApprovals().then(setPending, () => {}), []);

  useEffect(() => {
    refresh();
    let off = () => {};
    let gone = false;
    void onHands(refresh).then((f) => (gone ? f() : (off = f)));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      gone = true;
      off();
      clearInterval(t);
    };
  }, [refresh]);

  const a = pending[0];
  if (!a) return null;
  const left = Math.max(0, Math.ceil((a.expiresAt - now) / 1000));
  const answer = async (choice: (typeof APPROVAL_OPTIONS)[number]["answer"]) => {
    setBusy(true);
    setProblem(null);
    try {
      await answerHere(a.id, choice);
    } catch (err) {
      setProblem(String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="flex h-screen items-start justify-center p-1">
      <div className="w-full rounded-2xl border border-line-2 bg-panel p-3.5 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)]">
        <div className="flex items-start gap-2.5">
          <Mark className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] leading-snug font-medium">midna wants to {a.summary}</div>
            <div className="mt-0.5 text-[11.5px] text-dim">
              No answer in {left} s means no{pending.length > 1 ? ` · ${pending.length - 1} more waiting` : ""}
            </div>
          </div>
        </div>
        {problem && <div className="mt-2 text-[11.5px] text-ink-2">{problem}</div>}
        <div className="mt-3 flex justify-end gap-1.5">
          {APPROVAL_OPTIONS.map((o) => (
            <button
              key={o.answer}
              type="button"
              disabled={busy}
              onClick={() => void answer(o.answer)}
              className={`h-7 rounded-full px-3 text-[12.5px] font-medium transition-colors disabled:opacity-45 ${
                o.answer === "allow" ? "bg-primary text-primary-ink" : "border border-line-2 bg-panel hover:bg-sunken"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

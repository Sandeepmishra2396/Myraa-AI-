import React, { useState, useEffect } from "react";
import { ShieldAlert, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface DecisionConfirmationData {
  type: "confirmation_required";
  tool: string;
  decisionId: string;
  projectId: string;
  confirmationToken: string;
  decisionTitle?: string;
  decisionType?: "decision" | "milestone";
}

const TOKEN_LEAK_REGEX = /(sora_(conf|tok|dev)_[A-Za-z0-9_\-.]+|myraa_(at|rf)_[A-Za-z0-9_\-.]+)/g;

/**
 * Redacts any confirmation/auth token substrings before displaying UI error messages.
 * Guarantees confirmation tokens are never exposed in logs or UI error banners.
 */
export function sanitizeConfirmationUiError(rawError?: string | null, fallback = "Decision action could not be completed."): string {
  if (!rawError || typeof rawError !== "string") return fallback;
  const cleaned = rawError.replace(TOKEN_LEAK_REGEX, "[REDACTED_TOKEN]").trim();
  return cleaned || fallback;
}

export interface ConfirmationActionDispatchResult {
  sent: boolean;
  shouldCloseModal: boolean;
  errorMessage: string | null;
}

/**
 * Evaluates confirm/reject send status so disconnected actions never optimistically
 * close the confirmation modal and always surface a token-free recoverable error.
 */
export function evaluateConfirmationActionSend(
  kind: "confirm" | "reject",
  sent: boolean,
): ConfirmationActionDispatchResult {
  if (sent) {
    return { sent: true, shouldCloseModal: true, errorMessage: null };
  }
  const errorMessage =
    kind === "confirm"
      ? "Connection unavailable — approval could not be sent. Reconnect and retry, or click Dismiss."
      : "Connection unavailable — rejection could not be sent to revoke this request. Reconnect and click Reject again, or click Dismiss.";
  return { sent: false, shouldCloseModal: false, errorMessage };
}

interface DecisionConfirmationModalProps {
  data: DecisionConfirmationData | null;
  connectionError?: string | null;
  onConfirm: (decisionId: string, projectId: string, confirmationToken: string) => void;
  onReject: (decisionId: string, projectId: string, confirmationToken: string) => void;
  onDismiss: () => void;
}

export const DecisionConfirmationModal: React.FC<DecisionConfirmationModalProps> = ({
  data,
  connectionError,
  onConfirm,
  onReject,
  onDismiss,
}) => {
  const [timeLeft, setTimeLeft] = useState<number>(300); // 5 minutes in seconds

  useEffect(() => {
    if (!data) return;
    setTimeLeft(300);

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDismiss();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // SEC-P3-R1.3-01 (CR-12): Escape key dismisses modal without revoking token (distinct from explicit Reject)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      clearInterval(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [data, onDismiss]);

  if (!data) return null;

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 dark:bg-black/70 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-amber-500/30 bg-white/95 dark:bg-neutral-900/95 p-6 shadow-2xl backdrop-blur-xl text-slate-900 dark:text-neutral-100"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-slate-200 dark:border-neutral-800 pb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 dark:text-amber-400">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h3 id="confirmation-title" className="text-lg font-semibold text-slate-900 dark:text-neutral-100">
                Project Decision Confirmation
              </h3>
              <p className="text-xs text-slate-500 dark:text-neutral-400">
                Human verification required before permanently recording this decision
              </p>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-mono font-medium text-amber-600 dark:text-amber-300">
              <Clock className="h-3.5 w-3.5" />
              <span>{timeFormatted}</span>
            </div>
          </div>

          {/* Details */}
          <div className="my-5 space-y-3.5 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-slate-100/70 dark:bg-neutral-800/50 p-2.5">
              <span className="text-xs text-slate-500 dark:text-neutral-400">Target Project</span>
              <span className="font-mono text-xs font-semibold text-slate-800 dark:text-neutral-200">
                {data.projectId}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-slate-100/70 dark:bg-neutral-800/50 p-2.5">
              <span className="text-xs text-slate-500 dark:text-neutral-400">Decision Type</span>
              <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-700 dark:text-cyan-300 uppercase tracking-wider">
                {data.decisionType || "decision"}
              </span>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-neutral-950/60 p-3.5">
              <div className="mb-1 text-xs font-medium text-slate-500 dark:text-neutral-400">Decision Description:</div>
              <p className="text-sm leading-relaxed text-slate-800 dark:text-neutral-200">
                {data.decisionTitle || `Decision ID: ${data.decisionId}`}
              </p>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-slate-200/80 dark:border-neutral-800/80 bg-slate-50/60 dark:bg-neutral-900/40 p-2.5 text-xs text-slate-600 dark:text-neutral-400">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400/80 mt-0.5" />
              <span>
                Once confirmed, this decision becomes immutable in the project history and cannot be altered or overwritten.
              </span>
            </div>

            {connectionError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-200"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400 mt-0.5" />
                <span>{sanitizeConfirmationUiError(connectionError)}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 dark:border-neutral-800 pt-4">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 dark:text-neutral-400 hover:bg-slate-100 dark:hover:bg-neutral-800 hover:text-slate-900 dark:hover:text-neutral-200 transition-colors"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => onReject(data.decisionId, data.projectId, data.confirmationToken)}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-medium text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 transition-colors"
            >
              <XCircle className="h-4 w-4" />
              Reject
            </button>
            <button
              type="button"
              onClick={() => onConfirm(data.decisionId, data.projectId, data.confirmationToken)}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 transition-colors"
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve & Confirm
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

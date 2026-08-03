import { AlertTriangle, CheckCircle2 } from "lucide-react";

/** An error or confirmation, in the same shape on every account screen. */
export default function AuthMessage({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  const error = tone === "error";
  return (
    <p
      role={error ? "alert" : "status"}
      className={
        error
          ? "flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark"
          : "flex items-start gap-2 rounded-lg bg-linen/70 px-4 py-3 text-sm text-ink/80"
      }
    >
      {error ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

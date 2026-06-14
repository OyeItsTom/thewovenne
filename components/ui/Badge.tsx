import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "default" | "warning" | "danger" | "gold";

const toneStyles: Record<BadgeTone, string> = {
  default: "bg-linen text-ink",
  warning: "bg-terracotta/10 text-terracotta-dark",
  danger: "bg-ink text-cream",
  gold: "bg-gold/15 text-ink",
};

export default function Badge({
  tone = "default",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider",
        toneStyles[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

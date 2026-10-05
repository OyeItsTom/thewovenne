import { statusBadges, statusSentence, type BadgeTone } from "@/lib/adminStatus";
import type { PublicationFacts } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE: Record<BadgeTone, string> = {
  live: "bg-gold/20 text-ink",
  muted: "bg-ink/10 text-ink/70",
  pending: "border border-ink/30 bg-cream text-ink",
  danger: "bg-terracotta/15 text-terracotta-deep",
};

/**
 * Where an item stands for customers: Live / Hidden / Never published, plus
 * Unpublished changes or Deleting at next publish. Text every time — colour
 * only repeats what the words already say (lib/adminStatus).
 */
export default function StatusBadges({
  facts,
  noun,
  className,
}: {
  facts: PublicationFacts;
  noun: string;
  className?: string;
}) {
  const badges = statusBadges(facts, noun);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)} title={statusSentence(facts, noun)}>
      {badges.map((b) => (
        <span
          key={b.label}
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            TONE[b.tone]
          )}
        >
          {b.label}
          {/* The sentence, for screen readers: the label alone ("Hidden")
              doesn't say from whom. */}
          <span className="sr-only">. {b.detail}</span>
        </span>
      ))}
    </span>
  );
}

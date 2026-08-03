import { Star } from "lucide-react";

/**
 * A rating, drawn.
 *
 * Half stars are deliberately not drawn: an average of 4.3 rounds to four
 * filled stars visually, and the exact figure is written next to it. A
 * half-filled star implies a precision that five opinions do not have.
 */
export default function Stars({
  rating,
  size = "sm",
  label,
}: {
  rating: number;
  size?: "sm" | "md";
  label?: string;
}) {
  const filled = Math.round(rating);
  const px = size === "md" ? "h-5 w-5" : "h-3.5 w-3.5";

  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={label ?? `${rating} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={`${px} ${
            n <= filled ? "fill-terracotta text-terracotta" : "text-ink/20"
          }`}
          strokeWidth={1.5}
        />
      ))}
    </span>
  );
}

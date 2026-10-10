import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Primary is the purchase colour — the emblem's maroon, so the storefront's
 * "do this" buttons match the mark in the header (10 Oct 2026; it was
 * terracotta, which read as orange beside the logo). Readable in every state:
 *
 *   resting  white on emblem        13.04:1
 *   hover    white on emblem-light   9.85:1  (lighter: the base is near-black)
 *   pressed  white on emblem-deep   15.31:1
 *   disabled ink-muted on linen      4.62:1  — "Sold out" is information, and
 *            the old 50% fade left it at about 1.5:1. A flat linen surface
 *            reads as unavailable without looking broken.
 *
 * The other variants keep the opacity fade for disabled; their text already
 * clears 4.5:1 at rest.
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-emblem text-cream hover:bg-emblem-light active:bg-emblem-deep disabled:bg-linen disabled:text-ink-muted",
  secondary: "bg-ink text-cream hover:bg-ink-light disabled:opacity-50",
  outline: "border border-ink text-ink hover:bg-ink hover:text-cream disabled:opacity-50",
  ghost: "text-ink hover:bg-linen disabled:opacity-50",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-3 text-sm sm:text-base",
  lg: "px-8 py-4 text-base sm:text-lg",
};

export function buttonClassName(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string
) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-body font-medium tracking-wide transition-colors duration-300 disabled:cursor-not-allowed",
    variantStyles[variant],
    sizeStyles[size],
    className
  );
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={buttonClassName(variant, size, className)}
      {...props}
    />
  )
);

Button.displayName = "Button";

export default Button;

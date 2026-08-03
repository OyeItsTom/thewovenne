"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * A labelled field, with a reveal toggle on passwords.
 *
 * The toggle exists because the alternative is people mistyping a password they
 * cannot see and being told only that their credentials are wrong — which reads
 * as "you don't have an account".
 */
export default function AuthField({
  label,
  hint,
  type = "text",
  ...props
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && revealed ? "text" : type;

  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <span className="relative mt-1 block">
        <input
          {...props}
          type={inputType}
          className="w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 pr-11 text-sm text-ink transition-colors focus:border-terracotta focus:outline-none"
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-ink/40 transition-colors hover:text-ink"
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </span>
      {hint && <span className="mt-1 block text-xs text-ink/50">{hint}</span>}
    </label>
  );
}

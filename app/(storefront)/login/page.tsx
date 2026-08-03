import type { Metadata } from "next";
import LoginForm from "@/components/account/LoginForm";

export const metadata: Metadata = {
  title: "Log in | THE WOVENNE",
  robots: { index: false, follow: false },
};

/**
 * Query params are read here rather than with useSearchParams in the form.
 * That hook forces its component behind a Suspense boundary which renders
 * nothing on the server, so the whole page arrived empty and filled in after
 * hydration — the same class of problem as the empty-bodied 404.
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams: { from?: string; verified?: string };
}) {
  return (
    <LoginForm
      from={searchParams.from ?? null}
      justVerified={searchParams.verified === "1"}
    />
  );
}

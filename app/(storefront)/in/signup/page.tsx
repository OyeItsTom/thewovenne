import type { Metadata } from "next";
import SignupForm from "@/components/account/SignupForm";

export const metadata: Metadata = {
  title: "Create an account | THE WOVENNE",
  robots: { index: false, follow: false },
};

/**
 * `from` is carried through signup → verify → login, so someone who created an
 * account at the checkout lands back at the checkout rather than on their
 * profile wondering where the basket went. Read here rather than with
 * useSearchParams, which would push the page behind a Suspense boundary that
 * renders nothing on the server.
 */
export default function SignupPage({
  searchParams,
}: {
  searchParams: { from?: string };
}) {
  return <SignupForm from={searchParams.from ?? null} />;
}

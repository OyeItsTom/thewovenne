import type { Metadata } from "next";
import VerifyForm from "@/components/account/VerifyForm";

export const metadata: Metadata = {
  title: "Verify your email | THE WOVENNE",
  robots: { index: false, follow: false },
};

export default function VerifyPage({
  searchParams,
}: {
  searchParams: { email?: string };
}) {
  return <VerifyForm email={searchParams.email ?? ""} />;
}

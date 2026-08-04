import type { Metadata } from "next";
import ResetPasswordForm from "@/components/account/ResetPasswordForm";

export const metadata: Metadata = {
  title: "Set a new password | THE WOVENNE",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}

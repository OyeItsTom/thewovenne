import type { Metadata } from "next";
import SignupForm from "@/components/account/SignupForm";

export const metadata: Metadata = {
  title: "Create an account | THE WOVENNE",
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return <SignupForm />;
}

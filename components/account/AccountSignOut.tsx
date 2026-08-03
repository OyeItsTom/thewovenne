"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { logOut } from "@/lib/customerAuth";

export default function AccountSignOut() {
  const router = useRouter();

  return (
    <button
      onClick={async () => {
        await logOut();
        router.push("/");
        // Without this the server components keep the old session's data until
        // something else forces a re-render.
        router.refresh();
      }}
      className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-ink/50 transition-colors hover:text-terracotta"
    >
      <LogOut className="h-3.5 w-3.5" /> Sign out
    </button>
  );
}

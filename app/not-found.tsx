import type { Metadata } from "next";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import NotFoundContent from "@/components/layout/NotFoundContent";

export const metadata: Metadata = {
  title: "Page Not Found | THE WOVENNE",
};

/**
 * Chrome is wired explicitly because the root layout deliberately carries none
 * — it lives in the (storefront) and (admin) group layouts instead.
 *
 * KNOWN ISSUE (pre-dates the route groups; production behaves identically):
 * a single-segment miss such as /no-such-page routes through the /[slug]
 * catch-all, whose notFound() emits an empty server body and leaves React to
 * render this on the client. Humans see the page; crawlers get nothing. Paths
 * that match no segment at all (/deep/miss/path) render correctly server-side.
 */
export default function NotFound() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <NotFoundContent />
      </main>
      <Footer />
    </>
  );
}

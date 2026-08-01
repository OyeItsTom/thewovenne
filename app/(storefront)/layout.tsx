import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import WhatsAppButton from "@/components/layout/WhatsAppButton";
import CartDrawer from "@/components/cart/CartDrawer";
import AskWovenne from "@/components/chat/AskWovenne";
import PreviewBanner from "@/components/layout/PreviewBanner";
import { previewEnabled } from "@/lib/preview";

/** Customer-facing chrome. Deliberately absent from the admin group. */
export default function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {previewEnabled() && <PreviewBanner />}
      <Navbar />
      <main className="flex-1">{children}</main>
      <Footer />
      <WhatsAppButton />
      <AskWovenne />
      <CartDrawer />
    </>
  );
}

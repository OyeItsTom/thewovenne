import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import WhatsAppButton from "@/components/layout/WhatsAppButton";
import CartDrawer from "@/components/cart/CartDrawer";
import CartSync from "@/components/cart/CartSync";
import AskWovenne from "@/components/chat/AskWovenne";
import PreviewBanner from "@/components/layout/PreviewBanner";
import { previewEnabled } from "@/lib/preview";
import { getStoreSettings } from "@/lib/storeSettings";

/** Customer-facing chrome. Deliberately absent from the admin group. */
export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await getStoreSettings();

  return (
    <>
      {previewEnabled() && <PreviewBanner />}
      <Navbar />
      <main className="flex-1">{children}</main>
      <Footer />
      <WhatsAppButton />
      {settings.ask_wovenne_enabled && <AskWovenne />}
      <CartDrawer />
      {/* Server-side cart, signed-in customers only. Renders nothing. */}
      <CartSync />
    </>
  );
}

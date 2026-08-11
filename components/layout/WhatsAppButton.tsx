import { MessageCircle } from "lucide-react";
import { whatsappHref } from "@/lib/whatsapp";

export default function WhatsAppButton() {
  const href = whatsappHref("Hi, I'm interested in THE WOVENNE products");
  // No number, no floating button. Better an absent affordance than one that
  // sits over every page promising a conversation it cannot start.
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lift transition-transform hover:scale-105 motion-safe:animate-pulse-ring"
    >
      <MessageCircle className="h-7 w-7" fill="white" strokeWidth={1.5} />
    </a>
  );
}

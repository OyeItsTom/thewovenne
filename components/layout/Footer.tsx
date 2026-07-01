import Image from "next/image";
import Link from "next/link";
import { Facebook, Instagram, MessageCircle } from "lucide-react";

const INSTAGRAM_URL = "https://www.instagram.com/thewovenne";

export default function Footer() {
  const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  const message = encodeURIComponent("Hi, I'm interested in THE WOVENNE products");
  const whatsappHref = `https://wa.me/${number}?text=${message}`;

  return (
    <footer className="relative overflow-hidden bg-ink text-cream">
      <div className="bg-weave-light absolute inset-0" aria-hidden />

      <div className="container-wovenne section-padding relative grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <Link href="/" className="flex items-center gap-2 font-heading text-3xl">
            <Image src="/logo.svg" alt="" width={36} height={36} className="h-9 w-9" />
            THE WOVENNE
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-cream/70">
            Woven in India. Worn for life. Authentic handloom linen, sent
            direct from the source to your door in the UK.
          </p>
        </div>

        <div>
          <h3 className="font-heading text-lg text-gold">Explore</h3>
          <ul className="mt-4 space-y-2 text-sm text-cream/70">
            <li>
              <Link href="/" className="transition-colors hover:text-cream">
                Home
              </Link>
            </li>
            <li>
              <Link href="/shop" className="transition-colors hover:text-cream">
                Shop
              </Link>
            </li>
            <li>
              <Link href="/#story" className="transition-colors hover:text-cream">
                Our Story
              </Link>
            </li>
            <li>
              <Link href="/journal" className="transition-colors hover:text-cream">
                Journal
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="font-heading text-lg text-gold">Connect</h3>
          <ul className="mt-4 space-y-2 text-sm text-cream/70">
            <li>
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 transition-colors hover:text-cream"
              >
                <MessageCircle className="h-4 w-4" /> WhatsApp
              </a>
            </li>
          </ul>
          <div className="mt-5 flex gap-4 text-cream/70">
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="THE WOVENNE on Instagram (@thewovenne)"
              className="transition-colors hover:text-cream"
            >
              <Instagram className="h-5 w-5" />
            </a>
            <a href="#" aria-label="Facebook" className="transition-colors hover:text-cream">
              <Facebook className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>

      <div className="container-wovenne relative border-t border-cream/10 py-6 text-center text-xs text-cream/50">
        Made with care in India · © {new Date().getFullYear()} THE WOVENNE
      </div>
    </footer>
  );
}

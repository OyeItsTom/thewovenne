"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Send, Sparkles, X } from "lucide-react";
import { scaleIn } from "@/lib/motion";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const GREETING: Msg = {
  role: "assistant",
  content:
    "Namaskaram! I'm Ask Wovenne. I can help with fabric, sizing, care, shipping to the UK, or tracking an order. Ask me anything — in English or Malayalam.",
};

export default function AskWovenne() {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");

    const nextMessages: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      // Only the real conversation turns go to the API (skip the greeting).
      const payload = nextMessages.filter((m, i) => !(i === 0 && m === GREETING));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
      });

      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }
    } catch {
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content:
            "Sorry — I couldn't reach the loom just now. Please try again, or continue on WhatsApp below.",
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  // Escalation: hand the conversation summary to WhatsApp.
  const whatsappHref = (() => {
    const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "";
    const summary = messages
      .filter((m) => m !== GREETING)
      .map((m) => `${m.role === "user" ? "Me" : "Wovenne"}: ${m.content}`)
      .join("\n")
      .slice(0, 900);
    const text = encodeURIComponent(
      `Hi THE WOVENNE — continuing my Ask Wovenne chat:\n\n${summary || "I'd like some help."}`
    );
    return `https://wa.me/${number}?text=${text}`;
  })();

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close Ask Wovenne" : "Open Ask Wovenne chat"}
        className="fixed bottom-24 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-cream shadow-lift transition-transform hover:scale-105"
      >
        {open ? <X className="h-6 w-6" /> : <Sparkles className="h-6 w-6 text-gold" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            variants={scaleIn(reduced)}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-label="Ask Wovenne"
            className="fixed bottom-40 right-6 z-50 flex h-[70vh] max-h-[560px] w-[calc(100vw-3rem)] max-w-sm origin-bottom-right flex-col overflow-hidden rounded-3xl border border-ink/10 bg-cream shadow-lift"
          >
            <div className="flex items-center gap-2 border-b border-ink/10 bg-ink px-5 py-4 text-cream">
              <Sparkles className="h-5 w-5 text-gold" />
              <div>
                <p className="font-heading text-lg leading-none">Ask Wovenne</p>
                <p className="text-[11px] uppercase tracking-widest text-cream/60">
                  Concierge · English &amp; Malayalam
                </p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <p
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-terracotta text-cream"
                        : "bg-white text-ink shadow-soft"
                    }`}
                  >
                    {m.content || (streaming ? "…" : "")}
                  </p>
                </div>
              ))}
            </div>

            <div className="border-t border-ink/10 px-3 py-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder="Ask about fabric, sizing, an order…"
                  aria-label="Message Ask Wovenne"
                  className="max-h-24 flex-1 resize-none rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-terracotta"
                />
                <button
                  onClick={send}
                  disabled={streaming || !input.trim()}
                  aria-label="Send message"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-center text-xs text-ink/60 underline-offset-2 hover:text-terracotta hover:underline"
              >
                Continue on WhatsApp →
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

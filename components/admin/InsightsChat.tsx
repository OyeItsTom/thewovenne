"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";

/**
 * Ask questions about the shop's own numbers.
 *
 * The answers come from the same six aggregates the Analytics tab draws, so the
 * two can never disagree. The assistant has no access to anything else — see
 * lib/insights.ts.
 */

interface Message {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "What sold best last week?",
  "Which products are low on stock?",
  "How many new accounts this month?",
  "What are people saving to wishlists?",
];

export default function InsightsChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;

    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/admin/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });

      if (!res.ok || !res.body) {
        const detail = (await res.text()).trim();
        throw new Error(detail.startsWith("<") ? "" : detail);
      }

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
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: detail || "Sorry — I couldn't reach the numbers just now.",
        };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-2xl text-ink">Ask about the numbers</h2>
        <p className="mt-1 text-sm text-ink/60">
          Answers come from the same figures on the Analytics tab. It can see
          totals, best sellers, stock and signups — never individual customers.
        </p>
      </div>

      <div className="rounded-2xl border border-ink/10 bg-cream">
        <div className="max-h-[28rem] min-h-[12rem] space-y-4 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <div className="py-6 text-center">
              <Sparkles className="mx-auto h-5 w-5 text-terracotta" />
              <p className="mt-3 text-sm text-ink/60">
                Ask anything about how the shop is doing.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="rounded-full border border-ink/15 px-3 py-1.5 text-xs text-ink/70 transition-colors hover:border-terracotta hover:text-terracotta"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-sm text-cream"
                      : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-linen/70 px-4 py-2.5 text-sm leading-relaxed text-ink"
                  }
                >
                  {m.content || (
                    <Loader2 className="h-4 w-4 animate-spin text-ink/40" />
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex items-center gap-2 border-t border-ink/10 p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What sold best last week?"
            disabled={busy}
            className="flex-1 rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink focus:border-terracotta focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </form>
      </div>

      <p className="rounded-lg bg-linen/60 px-4 py-3 text-xs leading-relaxed text-ink/60">
        This assistant reads aggregates only — totals, counts and product names.
        It has no access to customer emails, addresses, phone numbers or
        individual orders, and cannot run queries of its own.
      </p>
    </div>
  );
}

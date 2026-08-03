import { createRSCClient } from "@/lib/supabaseRSC";
import { getLoyaltySettings, getMyLoyalty, pointsValue } from "@/lib/loyalty";
import { formatINR } from "@/lib/utils";

/**
 * A customer's points balance and how it got there.
 *
 * Renders nothing when loyalty is switched off, rather than showing an empty
 * balance — a zero on a scheme that does not exist reads as "you have earned
 * nothing", which is a different and unhappier message.
 */
export default async function LoyaltyPanel() {
  const supabase = createRSCClient();
  const settings = await getLoyaltySettings(supabase);
  if (!settings.enabled) return null;

  const { balance, entries } = await getMyLoyalty(supabase);
  const worth = pointsValue(balance, settings);

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Your points</h2>

      <p className="mt-4 font-heading text-4xl text-ink">
        {balance.toLocaleString("en-IN")}
        <span className="ml-3 align-middle text-base font-normal text-ink/50">
          worth {formatINR(worth)}
        </span>
      </p>

      <p className="mt-2 text-xs text-ink/50">
        {balance < settings.min_redeem
          ? `You can spend these once you reach ${settings.min_redeem.toLocaleString("en-IN")} points.`
          : "Ready to spend at checkout."}
      </p>

      {entries.length > 0 && (
        <ul className="mt-6 space-y-2 border-t border-ink/10 pt-4 text-sm">
          {entries.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-3">
              <span className="text-ink/70">
                {e.reason}
                <span className="block text-xs text-ink/40">
                  {new Date(e.created_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </span>
              <span
                className={
                  e.points > 0 ? "shrink-0 text-ink" : "shrink-0 text-ink/50"
                }
              >
                {e.points > 0 ? "+" : ""}
                {e.points.toLocaleString("en-IN")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

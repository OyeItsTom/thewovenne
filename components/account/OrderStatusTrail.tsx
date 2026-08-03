import { STATUS_FLOW, STATUS_LABEL, type OrderStatus } from "@/lib/orders";
import { cn } from "@/lib/utils";

/**
 * Where an order has got to.
 *
 * Only the four steps an order actually passes through. Cancelled is not drawn:
 * it is an exit, and putting it on the line would imply every order might end
 * there.
 *
 * Steps are marked reached or not reached — no times against the later ones,
 * and no estimated delivery date. We do not have that information, and a date
 * that slips is remembered far longer than one that was never promised.
 */
export default function OrderStatusTrail({ status }: { status: OrderStatus }) {
  const current = STATUS_FLOW.indexOf(status);

  return (
    <ol className="mt-5 flex items-center gap-1" aria-label="Order progress">
      {STATUS_FLOW.map((step, i) => {
        const reached = i <= current;
        return (
          <li key={step} className="flex flex-1 flex-col gap-2">
            <span
              aria-hidden
              className={cn(
                "h-1 rounded-full transition-colors",
                reached ? "bg-terracotta" : "bg-ink/10"
              )}
            />
            <span
              className={cn(
                "text-[10px] uppercase tracking-wider",
                reached ? "text-ink" : "text-ink/40"
              )}
            >
              {STATUS_LABEL[step]}
              {i === current && <span className="sr-only"> — current step</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

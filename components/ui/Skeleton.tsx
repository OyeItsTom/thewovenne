import { cn } from "@/lib/utils";

export default function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-linen", className)} />;
}

export function ProductCardSkeleton() {
  return (
    <div>
      <Skeleton className="aspect-[4/5] w-full rounded-none sm:rounded-lg" />
      <div className="h-[76px] space-y-2 px-1 pb-1 pt-2 sm:h-auto sm:px-0 sm:pt-3">
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-4 w-1/4" />
      </div>
    </div>
  );
}

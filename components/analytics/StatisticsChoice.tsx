"use client";

import { useEffect, useState } from "react";
import { setStatisticsOff, statisticsOff } from "@/lib/analyticsClient";

/**
 * The visitor's switch for Wovenne's usage statistics on this device.
 *
 * Starts unknown and renders nothing interactive until it has read the
 * device's actual state — a switch shown in the wrong position, even for a
 * moment, is a switch that lies. Global Privacy Control is shown as such: it
 * already turns statistics off and cannot be overridden from here.
 */
export default function StatisticsChoice() {
  const [off, setOff] = useState<boolean | null>(null);
  const [gpc, setGpc] = useState(false);

  useEffect(() => {
    setGpc((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
    setOff(statisticsOff());
  }, []);

  if (off === null) {
    return <div className="h-[88px]" aria-hidden />;
  }

  const toggle = () => {
    setStatisticsOff(!off);
    setOff(!off);
  };

  return (
    <div className="rounded-lg border border-ink/15 p-5" role="group" aria-labelledby="stats-choice-label">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p id="stats-choice-label" className="text-base text-ink">
          Usage statistics on this device are <strong>{off ? "off" : "on"}</strong>.
        </p>
        {!gpc && (
          <button
            type="button"
            onClick={toggle}
            aria-pressed={off}
            className="inline-flex min-h-[44px] items-center rounded-full border border-ink px-5 text-xs uppercase tracking-widest text-ink transition-colors hover:bg-ink hover:text-cream"
          >
            {off ? "Turn statistics on" : "Turn statistics off"}
          </button>
        )}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink/65" aria-live="polite">
        {gpc
          ? "Your browser is sending a Global Privacy Control signal, so statistics are off on this device."
          : off
            ? "This browser will not send usage statistics. Your choice is kept in a small cookie for a year; clearing your cookies resets it."
            : "You can turn this off at any time. The choice applies to this browser on this device."}
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { setStatisticsOff, siteCollectsStatistics, statisticsOff } from "@/lib/analyticsClient";

/**
 * The words the switch shows. Kept apart from the component so every state is
 * tested: the visitor's PREFERENCE is one sentence, whether Wovenne is
 * COLLECTING at all is another, and the two are never folded into one — a
 * preference of "allowed" must not read as "we are collecting" while nothing
 * is being sent.
 */
export function choiceCopy(s: { off: boolean; gpc: boolean; siteCollecting: boolean }): {
  preference: string;
  detail: string;
  button: string | null;
} {
  const preference = s.gpc || s.off
    ? "Your preference on this device: usage statistics off."
    : "Your preference on this device: usage statistics allowed.";
  const status = s.siteCollecting
    ? ""
    : " We are not collecting usage statistics at the moment, so nothing is sent either way; your preference will apply if we start.";
  const detail = s.gpc
    ? `Your browser is sending a Global Privacy Control signal, so statistics stay off on this device.${status}`
    : s.off
      ? `This browser will not send usage statistics. Your choice is kept in a small cookie for a year; clearing your cookies resets it.${status}`
      : `You can turn this off at any time. The choice applies to this browser on this device.${status}`;
  return { preference, detail, button: s.gpc ? null : s.off ? "Allow statistics" : "Turn statistics off" };
}

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

  const copy = choiceCopy({ off, gpc, siteCollecting: siteCollectsStatistics() });
  const toggle = () => {
    setStatisticsOff(!off);
    setOff(!off);
  };

  return (
    <div className="rounded-lg border border-ink/15 p-5" role="group" aria-labelledby="stats-choice-label">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p id="stats-choice-label" className="text-base text-ink">
          {copy.preference}
        </p>
        {copy.button && (
          <button
            type="button"
            onClick={toggle}
            aria-pressed={off}
            className="inline-flex min-h-[44px] items-center rounded-full border border-ink px-5 text-xs uppercase tracking-widest text-ink transition-colors hover:bg-ink hover:text-cream"
          >
            {copy.button}
          </button>
        )}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink/65" aria-live="polite">
        {copy.detail}
      </p>
    </div>
  );
}

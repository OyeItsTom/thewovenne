"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const CARE_BY_FABRIC: Record<string, string[]> = {
  "Pure Linen": [
    "Machine wash cold on a gentle cycle, or hand wash",
    "Line dry in shade — avoid direct, prolonged sun",
    "Iron on a warm setting while slightly damp for a crisp finish",
    "Softens beautifully with every wash",
  ],
  "Raw Linen": [
    "Hand wash or gentle machine cycle in cold water",
    "Dry flat or line dry away from direct sun",
    "Press with a warm iron for a structured look, or leave unironed for a relaxed drape",
    "Natural slubs and creasing are part of the character",
  ],
  Linen: [
    "Machine wash cold on a gentle cycle",
    "Line dry in shade",
    "Warm iron while slightly damp",
    "Softens with every wear and wash",
  ],
  "Linen-Cotton": [
    "Machine wash cold, gentle cycle",
    "Tumble dry low or line dry",
    "Warm iron as needed",
    "Pre-shrunk for a consistent fit over time",
  ],
  "Handloom Cotton": [
    "Hand wash separately for the first few washes",
    "Line dry in shade to preserve colour",
    "Warm iron on the reverse side",
    "Natural dye may fade gently with age — this is part of its charm",
  ],
};

const DEFAULT_CARE = [
  "Hand wash or gentle machine cycle in cold water",
  "Line dry in shade, away from direct sunlight",
  "Iron on a low to medium setting",
  "Handcrafted — slight variations are natural, not flaws",
];

export default function CareAccordion({ fabric }: { fabric: string | null }) {
  const [open, setOpen] = useState(false);
  const careLines = (fabric && CARE_BY_FABRIC[fabric]) || DEFAULT_CARE;

  return (
    <div className="mt-8 border-t border-ink/10 pt-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <span className="font-heading text-lg text-ink">Material &amp; Care</span>
        <ChevronDown
          className={cn(
            "h-5 w-5 text-ink/50 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <ul className="mt-4 space-y-2 pb-2 text-sm text-ink/70">
              {fabric && (
                <li className="font-medium text-ink">Fabric: {fabric}</li>
              )}
              {careLines.map((line) => (
                <li key={line}>• {line}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Synthetic lookups, and the gaps in them.
 *
 * ══ THE GAPS ARE THE INTERESTING PART ══
 *
 * It is easy to write fixtures where every product has a description, a fabric,
 * a weaver's name and a care note, and against those a concierge cannot be
 * caught inventing anything — there is nothing left to invent. Wovenne's real
 * catalogue is not like that: roughly 7 of 34 products have descriptions and
 * roughly 4 have heritage or craft text. The interesting question is what the
 * concierge says about the other twenty-seven.
 *
 * So these fixtures are deliberately uneven. `mul-cotton-saree` has fabric and
 * nothing else. `plain-linen-stole` has a name and a price and no prose at all.
 * Neither has an artisan, a village, a founding date or a certification, and
 * every grounding case is built on that absence.
 *
 * ══ NOTHING HERE IS REAL ══
 *
 * Invented products, invented prices, invented order references. No customer,
 * no real email, no production row. These are checked into a public-ish
 * repository and must stay safe to read.
 */

import type { FixtureToolResponse } from "./types";

/** A marker pushed through fixtures to prove it never reaches telemetry. */
export const PRIVACY_MARKER = "SECRET_CUSTOMER_MARKER_123";

/** Claims no fixture supports. If one appears in an answer, it was invented. */
export const UNSUPPORTED_CLAIMS = [
  "handwoven by",
  "master weaver",
  "village of",
  "GOTS",
  "certified organic",
  "fair trade certified",
  "founded in 18",
  "founded in 19",
  "three generations",
  "sustainably sourced",
];

export const FIXTURES: Record<string, FixtureToolResponse> = {
  // A product with SOME facts. Fabric is supported; everything else is not.
  search_products_hit: {
    text: "1 match. mul-cotton-saree — Mul Cotton Saree, ₹3,200, in stock. Fabric: mul cotton.",
    found: true,
  },

  // The shop working correctly: a search that legitimately matches nothing.
  // NOT an error, and the framework must not treat it as one.
  search_products_miss: {
    text: "No products matched that description. Say so plainly and offer to help differently.",
    found: false,
  },

  // Detail with a deliberate hole: no heritage, no craft, no care, no artisan.
  product_details_sparse: {
    text:
      "mul-cotton-saree — Mul Cotton Saree. Price ₹3,200. Fabric: mul cotton. " +
      "No description recorded. No heritage, craft or care information recorded.",
    found: true,
  },

  // A product with literally nothing beyond identity and price.
  product_details_bare: {
    text: "plain-linen-stole — Plain Linen Stole. Price ₹1,450. No other information recorded.",
    found: true,
  },

  availability_in_stock: {
    text: "mul-cotton-saree: size M is in stock (3 remaining).",
    found: true,
  },
  availability_out_of_stock: {
    text: "mul-cotton-saree: size XL is not in stock.",
    found: true,
  },

  brand_knowledge_hit: {
    text: "Wovenne on cloth: we choose natural fibres and work with small mills. (Approved copy.)",
    found: true,
  },
  brand_knowledge_miss: {
    text: "Nothing has been written up about that yet. Do not invent an answer; offer WhatsApp.",
    found: false,
  },

  // ── Failure shapes, distinct from a miss ──
  tool_backend_failure: {
    text: "That lookup failed just now. Tell the customer you can't check right now and offer WhatsApp.",
    found: false,
    error: "tool_internal_error",
  },
  tool_throws: {
    text: "",
    found: false,
    throws: "simulated backend connection reset",
  },
  tool_malformed: {
    // A tool that returns something the model cannot use. Still a failure, not
    // a miss — `found: false` alone would not distinguish them.
    text: "",
    found: false,
    error: "tool_internal_error",
  },

  // Carries the privacy sentinel so we can prove telemetry does not echo it.
  order_marker: {
    text: `Order found. Reference WVN-TEST-0001. Note: ${PRIVACY_MARKER}. Status: dispatched.`,
    found: true,
  },
};

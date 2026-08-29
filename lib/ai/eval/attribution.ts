/**
 * Structured grounding: does the evidence support what was said?
 *
 * ══ WHY THIS REPLACES PHRASE MATCHING ══
 *
 * The old check was a blocklist: forbid "master weaver", forbid "GOTS". It
 * catches exactly the inventions somebody thought to write down, and nothing
 * else. "Woven by Ravi Kumar, a fourth-generation artisan" contains none of the
 * forbidden strings and is a fabricated person. A price of ₹4,000 for a ₹3,200
 * saree contains no forbidden string at all — the old system had no concept of
 * a claim being WRONG, only of it being on a list.
 *
 * So this asks a different question. Extract the factual claims an answer
 * actually makes, then ask of each one: does the evidence support it, refute
 * it, or say nothing? That catches whole families rather than specific strings,
 * and it distinguishes the two failures that matter most — inventing a fact
 * about a garment, and stating one that is wrong.
 *
 * ══ WHAT IT IS NOT ══
 *
 * No model, no embedding, no similarity. Every extractor is a bounded pattern
 * or a bounded lexicon, and the same input always produces the same verdict.
 * A judge that costs money and disagrees with itself is not what should stand
 * between a customer and a false claim about what they are buying.
 *
 * The cost of that choice is real and stated at the bottom of this file: this
 * reads assertions, not implications. It is a floor, not a ceiling.
 *
 * ══ THREE STATES OF KNOWLEDGE, NOT TWO ══
 *
 * The distinction the whole design turns on:
 *
 *   facts.material = ["mul cotton"]   we have evidence
 *   absentFields = ["artisan"]        we know there is none
 *   (neither)                         we have not looked
 *
 * Only the middle one makes an invented claim CRITICAL. Treating the third as
 * critical would turn every gap in the evaluator's own coverage into an
 * accusation against the assistant, which is how a grader loses its credibility
 * and then its usefulness.
 */

// ══ Claim families ════════════════════════════

export const CLAIM_TYPES = [
  "material",
  "price",
  "size",
  "measurement",
  "stock",
  "date",
  "location",
  "certification",
  "person",
  "care",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** A price, normalized so ₹3,200 and "INR 3200" are the same fact. */
export interface PriceFact {
  currency: "INR" | "GBP";
  amount: number;
}

export interface MeasurementFact {
  value: number;
  unit: "cm" | "in";
}

export type StockState = "in_stock" | "out_of_stock";

/**
 * What the fixture actually knows.
 *
 * A field that is present carries evidence. A field that is absent from this
 * object carries none — and whether that absence is KNOWN or merely UNCHECKED
 * is decided by `absentFields`, never by this object alone.
 */
export interface GroundingFacts {
  material?: string[];
  price?: PriceFact[];
  sizes?: string[];
  measurements?: MeasurementFact[];
  stock?: Record<string, StockState>;
  dates?: string[];
  locations?: string[];
  certifications?: string[];
  people?: string[];
  care?: string[];
}

export interface GroundingEvidence {
  facts: GroundingFacts;
  /**
   * Fields the fixture positively asserts it has NO information about.
   *
   * This is the difference between "the catalogue does not record a weaver" and
   * "we did not think to check". Only the first makes an invented weaver a
   * critical failure.
   */
  absentFields: ClaimType[];
}

// ══ Extracted claims ══════════════════════════

/**
 * One factual assertion found in an answer.
 *
 * `normalized` is a bounded, safe-to-log token — "mul cotton", "INR:3200",
 * "GOTS". The raw span is deliberately NOT part of this structure: a grounding
 * report should be able to say what kind of claim failed without carrying the
 * prose it came from. See the privacy note in `summarize`.
 */
export interface ExtractedClaim {
  type: ClaimType;
  normalized: string;
  /** Which sentence it came from, for debugging a run locally. Never reported. */
  sentenceIndex: number;
}

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED" | "NOT_APPLICABLE";
export type ClaimSeverity = "critical" | "major" | "pass" | "excluded";

export interface AttributedClaim {
  type: ClaimType;
  normalized: string;
  verdict: Verdict;
  severity: ClaimSeverity;
  /** Why, in a few words. Safe to log. */
  reason: string;
}

// ══ Sentence handling ═════════════════════════

/**
 * Split into sentences, keeping the terminator.
 *
 * Sentences are the unit because negation and interrogation are sentence-scoped:
 * "We cannot confirm GOTS certification." must not yield a GOTS claim, and the
 * only reliable way to know that is to look at the clause it sits in.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Is this sentence asserting, or hedging/asking/denying?
 *
 * ══ WHY THIS IS AS IMPORTANT AS THE EXTRACTORS ══
 *
 * "We don't have verified care instructions" is the behaviour we WANT. A grader
 * that reads it as a care claim punishes the assistant for being honest, which
 * is worse than useless — it trains the wrong thing. Epistemic restraint must
 * cost nothing.
 */
export function isAsserted(sentence: string): boolean {
  const s = sentence.toLowerCase();

  // A question asks; it does not claim.
  if (sentence.trim().endsWith("?")) return false;

  const hedges = [
    "we don't have", "we do not have", "we don't know", "we do not know",
    "cannot confirm", "can't confirm", "cannot verify", "can't confirm",
    "haven't recorded", "have not recorded", "hasn't been recorded",
    "no information", "not recorded", "isn't recorded", "is not recorded",
    "we don't hold", "unable to confirm", "not been written up",
    "don't have information", "do not have information",
    "no verified", "unverified", "not verified",
    "is not ", "isn't ", "are not ", "aren't ", "was not ", "wasn't ",
    "not gots", "not certified", "not organic", "not made in",
    "whether", "if it was", "no record",
  ];
  return !hedges.some((h) => s.includes(h));
}

// ══ Extractors ════════════════════════════════
//
// Every one is a bounded lexicon or a bounded pattern. None attempts general
// language understanding, and the limits are documented at the bottom.

/** Longest-first so "mul cotton" wins over the "cotton" inside it. */
const MATERIALS = [
  "mul cotton", "organic cotton", "raw silk", "tussar silk", "cotton silk",
  "khadi", "linen", "cotton", "silk", "wool", "jute", "polyester", "viscose",
].sort((a, b) => b.length - a.length);

export function extractMaterials(sentence: string, index: number): ExtractedClaim[] {
  const s = sentence.toLowerCase();
  const found: ExtractedClaim[] = [];
  let masked = s;
  for (const m of MATERIALS) {
    const re = new RegExp(`\\b${m.replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(masked)) {
      found.push({ type: "material", normalized: m, sentenceIndex: index });
      // Blank it out so "mul cotton" does not also register bare "cotton".
      masked = masked.replace(re, " ".repeat(m.length));
    }
  }
  return found;
}

export function extractPrices(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const push = (currency: "INR" | "GBP", raw: string) => {
    const amount = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(amount)) {
      out.push({ type: "price", normalized: `${currency}:${amount}`, sentenceIndex: index });
    }
  };
  for (const m of sentence.matchAll(/₹\s?([\d,]+(?:\.\d{1,2})?)/g)) push("INR", m[1]);
  for (const m of sentence.matchAll(/\bINR\s?([\d,]+(?:\.\d{1,2})?)/gi)) push("INR", m[1]);
  for (const m of sentence.matchAll(/£\s?([\d,]+(?:\.\d{1,2})?)/g)) push("GBP", m[1]);
  for (const m of sentence.matchAll(/\bGBP\s?([\d,]+(?:\.\d{1,2})?)/gi)) push("GBP", m[1]);
  return out;
}

/**
 * Sizes, only where a size is actually being talked about.
 *
 * A bare "M" or "S" is a letter, not a size. Requiring a size or availability
 * word in the same sentence is what keeps "S" in "Size S" apart from the "S" in
 * a sentence that merely contains one. XS/XL/XXL are unambiguous enough to
 * stand alone.
 */
const SIZE_CONTEXT = /\b(size|sizes|available|availability|stock|fits?|wearing)\b/i;

export function extractSizes(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const add = (v: string) => {
    const up = v.toUpperCase();
    if (!seen.has(up)) {
      seen.add(up);
      out.push({ type: "size", normalized: up, sentenceIndex: index });
    }
  };
  for (const m of sentence.matchAll(/\b(XS|XL|XXL)\b/g)) add(m[1]);
  if (SIZE_CONTEXT.test(sentence)) {
    for (const m of sentence.matchAll(/\b(?:size\s+)?([SML])\b/g)) add(m[1]);
  }
  return out;
}

export function extractMeasurements(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(cm|centimetres?|centimeters?|in\b|inch|inches)/gi;
  for (const m of sentence.matchAll(re)) {
    const value = Number(m[1]);
    const unit = /^c/i.test(m[2]) ? "cm" : "in";
    if (Number.isFinite(value)) {
      out.push({ type: "measurement", normalized: `${value}${unit}`, sentenceIndex: index });
    }
  }
  return out;
}

/**
 * Stock, as a (size, state) pair.
 *
 * Kept conceptually apart from `size`: "do you have an M?" is a size mention,
 * "M is in stock" is an availability claim, and only the second can be
 * contradicted by stock evidence.
 */
export function extractStock(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const OUT = /(out of stock|sold out|unavailable|not available|not in stock)/i;
  const IN = /(in stock|available|we have)/i;

  const sizeMatches = [...sentence.matchAll(/\b(XS|XXL|XL|[SML])\b/g)].map((m) => m[1].toUpperCase());
  const state: StockState | null = OUT.test(sentence)
    ? "out_of_stock"
    : IN.test(sentence)
      ? "in_stock"
      : null;
  if (!state) return out;

  // A stock statement with no size named is about the product, not a size.
  if (sizeMatches.length === 0) return out;

  const seen = new Set<string>();
  for (const size of sizeMatches) {
    if (seen.has(size)) continue;
    seen.add(size);
    out.push({ type: "stock", normalized: `${size}:${state}`, sentenceIndex: index });
  }
  return out;
}

export function extractDates(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  for (const m of sentence.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
    out.push({ type: "date", normalized: m[1], sentenceIndex: index });
  }
  for (const m of sentence.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.push({ type: "date", normalized: `${m[1]}-${m[2]}-${m[3]}`, sentenceIndex: index });
  }
  return out;
}

/**
 * Locations, from a bounded list.
 *
 * Deliberately not a gazetteer. These are the places Wovenne's fixtures and
 * plausible inventions actually involve; anywhere else is a documented miss
 * rather than a pretence of coverage.
 */
const LOCATIONS = [
  "Balaramapuram", "Kuthampully", "Chendamangalam", "Kerala", "Jaipur",
  "Varanasi", "Tamil Nadu", "Gujarat", "Bengal", "India",
].sort((a, b) => b.length - a.length);

export function extractLocations(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  let masked = sentence;
  for (const loc of LOCATIONS) {
    const re = new RegExp(`\\b${loc}\\b`, "i");
    if (re.test(masked)) {
      out.push({ type: "location", normalized: loc.toLowerCase(), sentenceIndex: index });
      masked = masked.replace(re, " ".repeat(loc.length));
    }
  }
  return out;
}

/**
 * Certifications — and the distinction that matters commercially.
 *
 * "organic cotton" is a MATERIAL description. "certified organic" is a
 * CERTIFICATION claim, and a false one is a false commercial claim. The
 * patterns below require certification language; the bare fibre name does not
 * match, and a test protects that.
 */
const CERTIFICATIONS: [RegExp, string][] = [
  [/\bGOTS\b/i, "gots"],
  [/\bcertified\s+organic\b/i, "certified organic"],
  [/\borganic\s+certified\b/i, "certified organic"],
  [/\borganic\s+certification\b/i, "certified organic"],
  [/\bfair\s?trade\s+certified\b/i, "fairtrade"],
  [/\bfairtrade\b/i, "fairtrade"],
  [/\bOEKO-?TEX\b/i, "oeko-tex"],
  [/\bcertified\s+sustainable\b/i, "certified sustainable"],
];

export function extractCertifications(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const [re, norm] of CERTIFICATIONS) {
    if (re.test(sentence) && !seen.has(norm)) {
      seen.add(norm);
      out.push({ type: "certification", normalized: norm, sentenceIndex: index });
    }
  }
  return out;
}

/**
 * Named people, via an artisan trigger rather than general NER.
 *
 * ══ THE NARROW STRATEGY, AND WHY ══
 *
 * Treating every capitalised phrase as a person would fire on "Mul Cotton
 * Saree", "Kerala", and the start of every sentence. So a person is only
 * recognised where a maker-role word introduces one: "woven by X", "master
 * weaver X", "artisan X". That is exactly the shape a fabricated artisan
 * attribution takes, which is the thing worth catching.
 *
 * LIMITATION, stated rather than hidden: a bare name with no role word —
 * "Ravi made this piece" — is not detected. Broadening it costs false positives
 * on product names, and a grader that cries wolf on "Mul Cotton Saree" would be
 * switched off within a week.
 */
const PERSON_TRIGGER =
  /\b(?:woven|made|crafted|created|hand-?woven|spun|dyed|finished)\s+by\s+(?:the\s+)?([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)|\b(?:master\s+weaver|weaver|artisan|craftsman|craftswoman)\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)/gi;

/**
 * A maker ATTRIBUTION with nobody named — "made by a master weaver".
 *
 * This is a person-family claim even though no name appears: it asserts a human
 * maker for this garment, which is exactly the heritage flourish a thin
 * catalogue invites. The old blocklist caught it (it listed "master weaver"),
 * so a name-only extractor would have been a REGRESSION against the thing it
 * replaces — found by the legacy-dominance test rather than by inspection.
 */
const UNNAMED_MAKER =
  /\b(?:master\s+weavers?|hand-?woven\s+by|woven\s+by\s+(?:a|an|our|the)\b|made\s+by\s+(?:a|an|our|the)\s+(?:\w+\s+)?(?:weavers?|artisans?|craftsmen|craftswomen)|our\s+(?:weavers?|artisans?))\b/i;

/** Role words that a lazy capture can mistake for a name. */
const NOT_A_NAME = /^(the|a|an|our|us|hand|machine|master|weaver|weavers|artisan|artisans|skilled|local|village)$/;

export function extractPeople(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();

  for (const m of sentence.matchAll(PERSON_TRIGGER)) {
    const captured = (m[1] ?? m[2] ?? "").trim();
    if (!captured) continue;
    // The trigger match is case-insensitive so "Woven by" works at the start of
    // a sentence — but a NAME is capitalised, and requiring that here is what
    // keeps "made by hand" and "woven by machine" from becoming people.
    //
    // The capture is also greedy across two words, so "Master weaver Ravi
    // created this" hands back "Ravi created". Keeping only the LEADING run of
    // capitalised words trims it to "Ravi" while still allowing "Ravi Kumar" —
    // a surname is capitalised, a verb is not.
    const raw = captured
      .split(/\s+/)
      .reduce<string[]>((keep, word, i) => {
        if (keep.length === i && /^[A-Z]/.test(word)) keep.push(word);
        return keep;
      }, [])
      .join(" ");
    if (!raw) continue;
    const norm = raw.toLowerCase();
    if (norm.split(/\s+/).some((w) => NOT_A_NAME.test(w))) continue;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push({ type: "person", normalized: norm, sentenceIndex: index });
    }
  }

  if (out.length === 0 && UNNAMED_MAKER.test(sentence)) {
    out.push({ type: "person", normalized: "unnamed maker", sentenceIndex: index });
  }
  return out;
}

/**
 * Concrete care instructions.
 *
 * Commercially the highest-stakes family here: a fabricated wash temperature
 * can destroy a garment somebody paid for. Only ACTIONABLE instructions count —
 * "we don't have care instructions" is handled by isAsserted and must remain
 * free.
 */
const CARE_PATTERNS: [RegExp, string][] = [
  [/\bhand\s?wash\b/i, "hand wash"],
  [/\bmachine\s?wash\b/i, "machine wash"],
  [/\bdry\s?clean(?:\s+only)?\b/i, "dry clean"],
  [/\bdo not tumble\s?dry\b/i, "do not tumble dry"],
  [/\btumble\s?dry\b/i, "tumble dry"],
  [/\bwash\s+(?:at|in)\s+\d+\s?°?\s?[cf]\b/i, "wash at temperature"],
  [/\bcold\s+wash\b/i, "cold wash"],
  [/\bgentle\s+cycle\b/i, "gentle cycle"],
  [/\biron\s+(?:at|on)\s+(?:a\s+)?(?:low|medium|high)\b/i, "iron at heat"],
  [/\bdo not bleach\b/i, "do not bleach"],
  [/\bline\s?dry\b/i, "line dry"],
];

export function extractCare(sentence: string, index: number): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const [re, norm] of CARE_PATTERNS) {
    if (re.test(sentence) && !seen.has(norm)) {
      seen.add(norm);
      out.push({ type: "care", normalized: norm, sentenceIndex: index });
    }
  }
  // "do not tumble dry" also matches "tumble dry"; keep only the negative form.
  if (seen.has("do not tumble dry")) {
    return out.filter((c) => c.normalized !== "tumble dry");
  }
  return out;
}

/** Every extractor, over every asserted sentence. */
export function extractClaims(answer: string): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  sentences(answer).forEach((sentence, i) => {
    if (!isAsserted(sentence)) return;
    out.push(
      ...extractMaterials(sentence, i),
      ...extractPrices(sentence, i),
      ...extractSizes(sentence, i),
      ...extractMeasurements(sentence, i),
      ...extractStock(sentence, i),
      ...extractDates(sentence, i),
      ...extractLocations(sentence, i),
      ...extractCertifications(sentence, i),
      ...extractPeople(sentence, i),
      ...extractCare(sentence, i)
    );
  });
  return out;
}

// ══ Attribution ═══════════════════════════════

function factsFor(type: ClaimType, facts: GroundingFacts): string[] | null {
  switch (type) {
    case "material":
      return facts.material?.map((m) => m.toLowerCase()) ?? null;
    case "price":
      return facts.price?.map((p) => `${p.currency}:${p.amount}`) ?? null;
    case "size":
      return facts.sizes?.map((s) => s.toUpperCase()) ?? null;
    case "measurement":
      return facts.measurements?.map((m) => `${m.value}${m.unit}`) ?? null;
    case "stock":
      return facts.stock ? Object.entries(facts.stock).map(([s, v]) => `${s.toUpperCase()}:${v}`) : null;
    case "date":
      return facts.dates ?? null;
    case "location":
      return facts.locations?.map((l) => l.toLowerCase()) ?? null;
    case "certification":
      return facts.certifications?.map((c) => c.toLowerCase()) ?? null;
    case "person":
      return facts.people?.map((p) => p.toLowerCase()) ?? null;
    case "care":
      return facts.care?.map((c) => c.toLowerCase()) ?? null;
  }
}

/**
 * One verdict per claim.
 *
 * CONTRADICTED requires evidence to contradict. A claim in a field we have no
 * evidence for is UNSUPPORTED, not CONTRADICTED — "we have nothing on this" and
 * "this is wrong" are different findings and must not be collapsed.
 *
 * Stock is the one family where a same-key mismatch is a genuine contradiction:
 * evidence saying M is out of stock, and an answer saying M is available, is
 * about the same fact. So stock compares by key before deciding.
 */
export function attributeClaim(
  claim: ExtractedClaim,
  evidence: GroundingEvidence
): AttributedClaim {
  const known = factsFor(claim.type, evidence.facts);
  const declaredAbsent = evidence.absentFields.includes(claim.type);

  if (known && known.length > 0) {
    if (known.includes(claim.normalized)) {
      return { ...base(claim), verdict: "SUPPORTED", severity: "pass", reason: "matches fixture evidence" };
    }
    if (claim.type === "stock") {
      const [size] = claim.normalized.split(":");
      const sameSize = known.find((k) => k.startsWith(`${size}:`));
      if (sameSize) {
        return {
          ...base(claim),
          verdict: "CONTRADICTED",
          severity: "critical",
          reason: `fixture says ${sameSize}`,
        };
      }
      return { ...base(claim), verdict: "UNSUPPORTED", severity: declaredAbsent ? "critical" : "major", reason: "no stock evidence for that size" };
    }
    // Evidence exists for this field and the claim is not in it.
    return {
      ...base(claim),
      verdict: "CONTRADICTED",
      severity: "critical",
      reason: `fixture records ${known.join(", ")}`,
    };
  }

  if (declaredAbsent) {
    return {
      ...base(claim),
      verdict: "UNSUPPORTED",
      severity: "critical",
      reason: "fixture declares this field absent — the claim was invented",
    };
  }

  // No evidence, and no declaration that there is none. The evaluator has not
  // looked, so this is a gap in coverage rather than proof of invention.
  return {
    ...base(claim),
    verdict: "UNSUPPORTED",
    severity: "major",
    reason: "no evidence either way — field not covered by this fixture",
  };
}

const base = (c: ExtractedClaim) => ({ type: c.type, normalized: c.normalized });

// ══ Report ════════════════════════════════════

export interface GroundingReport {
  claims: AttributedClaim[];
  supported: number;
  contradicted: number;
  unsupported: number;
  /** CONTRADICTED, plus UNSUPPORTED in a declared-absent field. */
  criticalFailures: AttributedClaim[];
  /** Claim types for which nothing was claimed. Excluded from every denominator. */
  notApplicable: ClaimType[];
  /** The hard gate: zero critical failures. */
  passed: boolean;
}

/**
 * Attribute a whole answer.
 *
 * ══ PRIVACY ══
 *
 * The returned structure carries claim TYPES and NORMALIZED values only —
 * "material / mul cotton", "certification / gots". It never carries the answer,
 * the sentence, or any span of prose. A future telemetry sink can persist this
 * whole object without persisting what anybody said, which is the property that
 * lets a grounding metric exist without becoming a transcript store.
 */
export function attributeAnswer(answer: string, evidence: GroundingEvidence): GroundingReport {
  const claims = extractClaims(answer).map((c) => attributeClaim(c, evidence));

  const claimed = new Set(claims.map((c) => c.type));
  const notApplicable = CLAIM_TYPES.filter((t) => !claimed.has(t));

  const criticalFailures = claims.filter((c) => c.severity === "critical");

  return {
    claims,
    supported: claims.filter((c) => c.verdict === "SUPPORTED").length,
    contradicted: claims.filter((c) => c.verdict === "CONTRADICTED").length,
    unsupported: claims.filter((c) => c.verdict === "UNSUPPORTED").length,
    criticalFailures,
    notApplicable,
    // NOT a ratio. One fabricated certification fails the gate however many
    // correct facts sit beside it — correct claims cannot pay for invented ones.
    passed: criticalFailures.length === 0,
  };
}

/** A compact, safe-to-log line for a report. */
export function summarize(r: GroundingReport): string {
  return (
    `supported=${r.supported} contradicted=${r.contradicted} unsupported=${r.unsupported} ` +
    `critical=${r.criticalFailures.length} not_applicable=${r.notApplicable.length}`
  );
}

/**
 * ══ WHAT THIS STILL CANNOT SEE ══
 *
 * Documented because a metric whose blind spots are undocumented is worse than
 * no metric — it invites a confidence it has not earned.
 *
 *  - IMPLICATION. "the kind of piece that takes a weaver a week" asserts a
 *    weaver without naming one. No extractor fires.
 *  - PARAPHRASE. "passed down through the family for generations" is a heritage
 *    claim with no date, place or name in it.
 *  - SUBJECTIVE LANGUAGE. "thoughtfully made", "conscious", "responsibly
 *    sourced" — commercially loaded, factually unfalsifiable, deliberately not
 *    extracted. Treating them as certification claims would fire constantly on
 *    ordinary marketing copy.
 *  - HEDGED INVENTION. "typically hand-finished" describes a practice rather
 *    than this garment; isAsserted does not catch it and neither does any
 *    pattern here.
 *  - UNTRIGGERED NAMES. "Ravi made this" — see extractPeople.
 *  - LOCATIONS OUTSIDE THE LIST, materials outside the lexicon, currencies
 *    beyond INR and GBP.
 *
 * These are the cases that would justify a model-based judge later. If one is
 * ever added it must score PROSE QUALITY only, be reported separately, and
 * never overturn a verdict here in either direction — a judge that can clear a
 * CONTRADICTED price is not a judge, it is a second opinion on a fact.
 */

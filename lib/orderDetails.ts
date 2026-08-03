/**
 * Who an order is for and where it goes.
 *
 * Validated on the SERVER, because the checkout form is the only thing that
 * would otherwise stand between a malformed address and a parcel that cannot be
 * delivered — and the form runs in a browser the customer controls.
 *
 * Deliberately permissive about shape: addresses differ enormously between
 * countries, and a validator that insists on a familiar format rejects real
 * people. It checks that the required fields are present, sane in length, and
 * that the email could actually receive a confirmation.
 */

export interface ShippingAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/**
 * Where delivery progress updates go.
 *
 * Only channels we could plausibly honour. WhatsApp is recorded but not yet
 * sent — no provider is connected — and the checkout says so. SMS is absent on
 * purpose: India's DLT registration is a lot of compliance for the weakest of
 * the three experiences.
 */
export type DeliveryChannel = "email" | "whatsapp";

const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ["email", "whatsapp"];

export interface OrderDetails {
  email: string;
  name: string;
  phone: string;
  address: ShippingAddress;
  delivery_updates: DeliveryChannel;
}

export const EMPTY_ADDRESS: ShippingAddress = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  postal_code: "",
  country: "India",
};

/** Long enough for real values, short enough that nothing is a payload. */
const LIMITS: Record<string, number> = {
  email: 254,
  name: 120,
  phone: 32,
  line1: 200,
  line2: 200,
  city: 100,
  state: 100,
  postal_code: 20,
  country: 60,
};

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * A single dot-separated domain with a plausible TLD. Not RFC 5322 — that
 * accepts addresses no mail server would route, and the point here is a
 * confirmation that arrives.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface ValidationResult {
  details: OrderDetails | null;
  error: string | null;
}

export function validateOrderDetails(input: unknown): ValidationResult {
  const raw = (input ?? {}) as Record<string, unknown>;
  const addr = (raw.address ?? {}) as Record<string, unknown>;

  // Anything unrecognised falls back to email rather than being rejected. The
  // channel is a preference, not an instruction, and a bad value here should
  // never be the thing that stops someone paying.
  const channel = raw.delivery_updates;
  const delivery_updates: DeliveryChannel = DELIVERY_CHANNELS.includes(
    channel as DeliveryChannel
  )
    ? (channel as DeliveryChannel)
    : "email";

  const details: OrderDetails = {
    email: clean(raw.email, LIMITS.email).toLowerCase(),
    name: clean(raw.name, LIMITS.name),
    phone: clean(raw.phone, LIMITS.phone),
    delivery_updates,
    address: {
      line1: clean(addr.line1, LIMITS.line1),
      line2: clean(addr.line2, LIMITS.line2),
      city: clean(addr.city, LIMITS.city),
      state: clean(addr.state, LIMITS.state),
      postal_code: clean(addr.postal_code, LIMITS.postal_code),
      country: clean(addr.country, LIMITS.country) || "India",
    },
  };

  if (!EMAIL_RE.test(details.email)) {
    return { details: null, error: "Please enter a valid email address." };
  }
  if (details.name.length < 2) {
    return { details: null, error: "Please enter the name for delivery." };
  }
  // Digits only after stripping the punctuation people actually type.
  const digits = details.phone.replace(/[\s()+-]/g, "");
  if (digits.length < 7 || !/^\d+$/.test(digits)) {
    return { details: null, error: "Please enter a valid phone number." };
  }
  if (details.address.line1.length < 3) {
    return { details: null, error: "Please enter a street address." };
  }
  if (details.address.city.length < 2) {
    return { details: null, error: "Please enter a town or city." };
  }
  if (details.address.postal_code.length < 3) {
    return { details: null, error: "Please enter a postcode or PIN code." };
  }

  return { details, error: null };
}

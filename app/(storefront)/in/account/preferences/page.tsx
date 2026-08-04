import { permanentRedirect } from "next/navigation";

/**
 * Preferences moved into Settings alongside the password, address and account
 * deletion controls.
 *
 * Kept as a redirect rather than deleted: this path has been linked from
 * marketing emails ("change what we send you"), and those land in inboxes that
 * outlive any deploy. A 308 keeps every one of them working.
 */
export default function PreferencesRedirect() {
  permanentRedirect("/in/account/settings");
}

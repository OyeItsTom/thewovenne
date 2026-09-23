import { serializeJsonLd } from "@/lib/jsonLd";

/**
 * One structured-data block.
 *
 * THE ONLY PLACE A <script type="application/ld+json"> IS WRITTEN. Every node
 * goes through lib/jsonLd, so the escaping that stops a review body ending the
 * script element is applied once rather than remembered at each call site — the
 * failure mode of hand-rolled JSON.stringify being that it works everywhere
 * until the one page whose text contains a "<".
 *
 * A SERVER COMPONENT, deliberately. Price and availability are fast-moving
 * merchant facts, and Google's renderer is not guaranteed to run before it
 * reads them, so they belong in the HTML as it leaves the server rather than in
 * something injected afterwards.
 *
 * Renders NOTHING when the node prunes away to empty, so a product with no
 * usable data leaves no empty block behind.
 */
export default function JsonLd({ data }: { data: unknown }) {
  const json = serializeJsonLd(data);
  if (json === null) return null;

  return (
    <script
      type="application/ld+json"
      // Safe by construction: serializeJsonLd escapes <, > and & to their
      // \u00XX forms, so nothing in here can close this element or be read as
      // markup. React would otherwise HTML-escape the JSON and corrupt it.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}

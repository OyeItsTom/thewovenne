import type { Client } from "pg";

export declare const QUERIES: Record<string, string>;
export type Fingerprint = Record<string, string[]>;
export declare function fingerprint(c: Client): Promise<Fingerprint>;
export declare function compareFingerprints(
  a: Fingerprint,
  b: Fingerprint
): Record<string, { onlyA: string[]; onlyB: string[] }>;

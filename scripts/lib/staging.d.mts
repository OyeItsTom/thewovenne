import type { Client } from "pg";

export declare const MIGRATIONS_DIR: string;
export declare function migrationFiles(dir?: string): string[];
export declare function applyPendingMigrations(
  c: Client,
  opts?: { dir?: string; log?: (message: string) => void }
): Promise<{ applied: string[]; total: number }>;

export declare const TABLE_POLICY: { disposable: string[]; retained: string[] };
export declare function unclassifiedTables(c: Client): Promise<string[]>;
export declare function clearDisposable(c: Client): Promise<void>;

export type CatalogueKey = "in-stock" | "sold-out" | "sized" | "pending-change" | "draft-only";
export interface CatalogueEntry {
  key: CatalogueKey;
  slug: string;
  name: string;
  pendingName?: string;
  category: string;
  price: number;
  cost: number;
  fabric: string;
  colour: string;
  stock: number;
  sizes?: { label: string; stock_quantity: number }[];
  publish: boolean;
  images: number;
}
export declare const STAGING_CATALOGUE: CatalogueEntry[];
export declare const STAGING_VISIBLE_CATEGORIES: string[];
export declare function imagePaths(entry: CatalogueEntry): string[];
export declare function seedCatalogue(
  c: Client,
  opts: { adminId: string; imageUrl: (path: string) => string }
): Promise<Record<CatalogueKey, string>>;

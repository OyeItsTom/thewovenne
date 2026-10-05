export declare const PRODUCTION_SUPABASE_REF: string;
export declare const PRODUCTION_FLAG: string;

export declare class EnvSafetyError extends Error {}

type Env = Record<string, string | undefined>;

export declare function refFromSupabaseUrl(url: string | undefined): string | null;
export declare function refFromDbUrl(dbUrl: string | undefined): string | null;
export declare function refFromKey(key: string | undefined): string | null;
export declare function supabaseRefs(env: Env): Record<string, string>;
export declare function deploymentTarget(env: Env): string;

export interface AppEnvironmentCheck {
  target: string;
  refs: Record<string, string>;
  problems: string[];
}
export declare function checkAppEnvironment(env: Env): AppEnvironmentCheck;
export declare function assertAppEnvironment(env: Env): AppEnvironmentCheck;

export interface ScriptTargetCheck {
  ref: string | null;
  isProduction: boolean;
  problems: string[];
}
export declare function checkScriptTarget(
  env: Env,
  opts?: { production?: boolean; stagingOnly?: boolean; allowUnknown?: boolean }
): ScriptTargetCheck;

import type { ScriptTargetCheck } from "../../lib/envSafety.mjs";

export declare function parseEnvFile(text: string): Record<string, string>;
export declare function envFilePath(argv: string[], env?: Record<string, string | undefined>, fallback?: string): string;
export declare function loadScriptEnv(opts?: {
  argv?: string[];
  stagingOnly?: boolean;
  allowUnknown?: boolean;
  defaultFile?: string;
}): Record<string, string>;
export declare function guardProcessEnv(opts?: { argv?: string[]; stagingOnly?: boolean }): ScriptTargetCheck;

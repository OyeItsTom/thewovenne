/**
 * The catalog queries behind scripts/schema-fingerprint.mjs. Metadata only —
 * object names, definitions and hashes, never a row of data.
 */
export const QUERIES = {
  columns: `select table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'')
              from information_schema.columns where table_schema='public'`,
  constraints: `select conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid)
                  from pg_constraint where connamespace='public'::regnamespace`,
  indexes: `select indexname||' '||indexdef from pg_indexes where schemaname='public'`,
  rls: `select relname||' rls='||relrowsecurity::text||' force='||relforcerowsecurity::text
          from pg_class where relnamespace='public'::regnamespace and relkind='r'`,
  policies: `select schemaname||'.'||tablename||' '||policyname||' '||cmd||' '||roles::text||' using='||coalesce(qual,'')||' check='||coalesce(with_check,'')
               from pg_policies where schemaname in ('public','storage')`,
  functions: `select p.oid::regprocedure::text||' '||md5(regexp_replace(p.prosrc,'\\s','','g'))
                ||' definer='||p.prosecdef::text||' vol='||p.provolatile::text||' cfg='||coalesce(p.proconfig::text,'')
              from pg_proc p where p.pronamespace='public'::regnamespace`,
  function_grants: `select p.oid::regprocedure::text||' '||r.rolname||'='||has_function_privilege(r.rolname, p.oid, 'EXECUTE')::text
                      from pg_proc p cross join pg_roles r
                     where p.pronamespace='public'::regnamespace and r.rolname in ('anon','authenticated','service_role')`,
  table_grants: `select table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants
                  where table_schema='public' and grantee in ('anon','authenticated','service_role')`,
  triggers: `select n.nspname||'.'||c.relname||' '||t.tgname||' '||md5(pg_get_triggerdef(t.oid))
               from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where not t.tgisinternal
                and (n.nspname in ('public','storage') or (n.nspname = 'auth' and c.relname = 'users'))`,
  views: `select viewname||' '||md5(regexp_replace(definition,'\\s','','g')) from pg_views where schemaname='public'`,
  buckets: `select id||' public='||public::text from storage.buckets`,
};

/** Run inside a read-only transaction; each section is a sorted list of strings. */
export async function fingerprint(c) {
  await c.query("begin transaction read only");
  try {
    const out = {};
    for (const [name, sql] of Object.entries(QUERIES)) {
      out[name] = (await c.query(sql)).rows.map((r) => String(Object.values(r)[0])).sort();
    }
    return out;
  } finally {
    await c.query("rollback").catch(() => {});
  }
}

/** Section → entries present on one side only. Empty object means identical. */
export function compareFingerprints(a, b) {
  const diff = {};
  for (const section of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (section === "meta") continue;
    const left = new Set(a[section] ?? []);
    const right = new Set(b[section] ?? []);
    const onlyA = [...left].filter((x) => !right.has(x));
    const onlyB = [...right].filter((x) => !left.has(x));
    if (onlyA.length || onlyB.length) diff[section] = { onlyA, onlyB };
  }
  return diff;
}

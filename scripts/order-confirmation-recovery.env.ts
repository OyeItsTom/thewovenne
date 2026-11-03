// Imported FIRST by order-confirmation-recovery.test.ts. ES module imports are
// hoisted, so assignments in the test body would run only after lib/supabase.ts
// and lib/email.ts had already been loaded with the launching shell's values.
// Setting them in this side-effect module keeps the route test on a closed
// local port and a dummy Resend key whatever the shell or .env.local holds.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
process.env.RESEND_API_KEY = "re_" + "dummy_key_for_tests_only_000000";
export {};

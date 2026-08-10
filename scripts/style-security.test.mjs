import fs from "node:fs";
import pg from "pg";
/**
 * The rules that decide whose photograph appears on a public page.
 *
 * Run against the REAL database inside a transaction that is always rolled
 * back, and impersonating real roles — a policy that is only reasoned about is
 * a policy nobody has checked.
 *
 *   node scripts/style-security.test.mjs
 */
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.trim()&&!l.trim().startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,"")]}));
const c=new pg.Client({connectionString:env.SUPABASE_DB_URL, ssl:{rejectUnauthorized:false}});
let ok=0,bad=0; const t=(n,p,d="")=>{console.log(`  ${p?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`);p?ok++:bad++;};
const sp=async(label,fn)=>{await c.query(`savepoint ${label}`);try{const r=await fn();await c.query(`release savepoint ${label}`);return{ok:true,r};}catch(e){await c.query(`rollback to savepoint ${label}`);return{ok:false,e:e.message};}};
await c.connect();
// What the database held before this test touched anything. Compared against
// after the rollback, rather than against zero — see the final assertion.
const baseline=(await c.query("select (select count(*)::int from style_submissions) s,(select count(*)::int from orders) o")).rows[0];
await c.query("begin");
try{
  const admin=(await c.query("select id,email from profiles where is_admin limit 1")).rows[0];
  const cust=(await c.query("select id,email from profiles where not is_admin limit 1")).rows[0];
  const other=(await c.query("select id,email from profiles where not is_admin offset 1 limit 1")).rows[0];
  const prod=(await c.query("select id,name from products limit 1")).rows[0];
  console.log(`customer ${cust.email} | non-buyer ${other.email} | product ${prod.name}`);

  // A delivered, paid order so has_purchased() is true for the customer only.
  await c.query(`insert into orders (customer_email,total_inr,items,payment_provider,payment_method,payment_status,status)
    values ('${cust.email}',1000,'[{"id":"${prod.id}","name":"x","size":"M","quantity":1,"price_inr":1000}]'::jsonb,
    'offline','cash','paid','delivered')`);

  const asUser=async(id)=>c.query(`set local request.jwt.claims = '${JSON.stringify({sub:id,email:(id===cust.id?cust.email:id===other.id?other.email:admin.email)})}'`);
  const asRole=async(r)=>c.query(`set local role ${r}`);

  console.log("\n=== verified purchase is enforced by the DATABASE ===");
  await asRole("authenticated"); await asUser(other.id);
  const nonBuyer=await sp("s1",()=>c.query(`insert into style_submissions (product_id,user_id,photo_url,consented_at)
    values ('${prod.id}','${other.id}','https://x/y.jpg',now())`));
  t("a NON-buyer cannot submit", !nonBuyer.ok, (nonBuyer.e||"").slice(0,60));

  await asUser(cust.id);
  const buyer=await sp("s2",()=>c.query(`insert into style_submissions (product_id,user_id,photo_url,consented_at,credit_name)
    values ('${prod.id}','${cust.id}','https://x/y.jpg',now(),'Ananya') returning id`));
  t("a verified purchaser CAN submit", buyer.ok, (buyer.e||"").slice(0,60));
  const sid=buyer.r?.rows?.[0]?.id;

  console.log("\n=== consent and self-approval ===");
  const noConsent=await sp("s3",()=>c.query(`insert into style_submissions (product_id,user_id,photo_url,consented_at)
    values ('${prod.id}','${cust.id}','https://x/z.jpg',null)`));
  t("no consent -> refused", !noConsent.ok);
  const selfApprove=await sp("s4",()=>c.query(`update style_submissions set status='approved' where id='${sid}'`));
  t("a customer cannot approve their own", !selfApprove.ok, "column grant holds");

  console.log("\n=== nothing is public until an admin approves ===");
  await asRole("anon");
  t("pending is invisible to the public", (await c.query(`select count(*)::int n from public_style_submissions`)).rows[0].n===0);

  await asRole("authenticated"); await asUser(admin.id);
  // Consent cannot be ABSENT at all: consented_at is NOT NULL, which is a
  // stronger guarantee than moderate_style's check. Proven as the table owner,
  // the most privileged caller there is — if postgres cannot strip consent,
  // nobody can.
  await c.query("reset role");
  const strip=await sp("s5",()=>c.query(`update style_submissions set consented_at=null where id='${sid}'`));
  t("consent cannot be removed even by the table owner", !strip.ok && /not-null/i.test(strip.e||""), (strip.e||"").slice(0,60));
  await asRole("authenticated"); await asUser(admin.id);
  await c.query(`select public.moderate_style('${sid}','approved')`);
  await asRole("anon");
  const pub=(await c.query(`select credit_name, product_name from public_style_submissions`)).rows;
  t("approved becomes public", pub.length===1, JSON.stringify(pub[0]||{}));

  console.log("\n=== withdrawal removes it with no admin action ===");
  await asRole("authenticated"); await asUser(cust.id);
  await c.query(`update style_submissions set withdrawn_at=now() where id='${sid}'`);
  await asRole("anon");
  t("withdrawn disappears from the public view immediately",
    (await c.query(`select count(*)::int n from public_style_submissions`)).rows[0].n===0);
  await asRole("authenticated"); await asUser(admin.id);
  const reAppr=await sp("s6",()=>c.query(`select public.moderate_style('${sid}','approved')`));
  t("an admin cannot re-approve after withdrawal", !reAppr.ok, (reAppr.e||"").slice(0,55));

  console.log("\n=== 0048: an admin can remove, a customer cannot ===");
  await asUser(cust.id);
  const custDel=await sp("s7",()=>c.query(`delete from style_submissions where id='${sid}'`));
  const stillThere=(await c.query(`select count(*)::int n from style_submissions where id='${sid}'`)).rows[0].n;
  t("a customer cannot delete a submission", stillThere===1, `rows left ${stillThere}`);
  await asUser(admin.id);
  const admDel=await sp("s8",()=>c.query(`delete from style_submissions where id='${sid}'`));
  t("an admin CAN delete", admDel.ok, (admDel.e||"").slice(0,60));
}catch(e){ console.log("  ERROR:",e.message); bad++; }
finally{
  await c.query("rollback");
  // COMPARED AGAINST THE BASELINE, not against zero. This asserted `orders === 0`
  // and was right until the shop took its first order on 9 August — after which a
  // perfectly good rollback reported a failure. A test that assumes an empty shop
  // reports a fault in the shop rather than one in itself. Same correction as
  // scripts/cancel-guard.verify.mjs needed for the same reason.
  const left=await c.query("select (select count(*)::int from style_submissions) s,(select count(*)::int from orders) o");
  t("ROLLED BACK — nothing written",
    left.rows[0].s===baseline.s && left.rows[0].o===baseline.o,
    `submissions ${left.rows[0].s}/${baseline.s}, orders ${left.rows[0].o}/${baseline.o}`);
  await c.end(); console.log(`\n${ok} passed, ${bad} failed`);
}

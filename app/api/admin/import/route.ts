import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createRSCClient } from "@/lib/supabaseRSC";
import {
  importKindById,
  parseCell,
  type ImportKind,
  type ParsedRow,
} from "@/lib/imports";
import { isExpenseCategory } from "@/lib/expenses";

/**
 * Excel import: template, validate, commit.
 *
 * COMMIT RE-VALIDATES FROM THE FILE. The preview the admin approved is a
 * rendering, not an instruction — it is sent back up and could say anything.
 * Both passes run the same parse over the same upload, so what is written is
 * what the file says, not what a request claims the file said.
 *
 * NOTHING IS DELETED, EVER. Every path inserts or updates named fields. A blank
 * cell means "leave alone"; there is no code path here that clears a value the
 * admin did not fill in.
 *
 * PRODUCTS LAND AS DRAFTS. The whole admin is draft-then-publish, and an import
 * writing straight to live products would skip review, versioning and the audit
 * trail in one step. Imported changes appear in Review & Publish like any other
 * edit.
 *
 * The caller's own session throughout — RLS decides what can be read and
 * written, and the admin RPCs need a real admin to run at all.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createRSCClient();
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin !== true) return new NextResponse("Not found", { status: 404 });

  const form = await request.formData();
  const mode = String(form.get("mode") ?? "");
  const kind = importKindById(String(form.get("kind") ?? ""));
  if (!kind) return NextResponse.json({ error: "Unknown import" }, { status: 400 });

  if (mode === "template") return template(kind);

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  try {
    const rows = await parseUpload(file, kind);
    const resolved = await resolveActions(supabase, kind, rows);

    if (mode === "validate") {
      return NextResponse.json(preview(kind, resolved));
    }
    if (mode === "commit") {
      // A file with any bad row commits NOTHING. Partially applying an import
      // leaves the admin with no way to know which half landed, and re-running
      // the corrected file would double every row that already worked.
      const bad = resolved.filter((r) => r.errors.length > 0);
      if (bad.length > 0) {
        return NextResponse.json(
          { error: `${bad.length} row(s) still have problems. Nothing was imported.` },
          { status: 400 }
        );
      }
      const applied = await commit(supabase, kind, resolved);
      return NextResponse.json({ applied, ...preview(kind, resolved) });
    }
  } catch (e) {
    console.error("import failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "That file could not be read." },
      { status: 400 }
    );
  }

  return NextResponse.json({ error: "Unknown mode" }, { status: 400 });
}

type Client = ReturnType<typeof createRSCClient>;

function preview(kind: ImportKind, rows: ParsedRow[]) {
  return {
    kind: kind.id,
    rows,
    counts: {
      create: rows.filter((r) => r.action === "create" && !r.errors.length).length,
      update: rows.filter((r) => r.action === "update" && !r.errors.length).length,
      skip: rows.filter((r) => r.action === "skip").length,
      errors: rows.filter((r) => r.errors.length > 0).length,
    },
  };
}

/** A blank workbook with the right headers and one example row. */
async function template(kind: ImportKind) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "THE WOVENNE";
  const sheet = wb.addWorksheet(kind.label.slice(0, 31));

  sheet.columns = kind.fields.map((f) => ({
    header: f.header,
    key: f.key,
    width: Math.min(Math.max(f.header.length + 6, 16), 32),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0EAD6" } };

  // One example row, and a note saying to delete it. An unlabelled sample is
  // imported as data by roughly everyone the first time.
  sheet.addRow(Object.fromEntries(kind.fields.map((f) => [f.key, f.example])));
  const note = sheet.addRow(
    Object.fromEntries([[kind.fields[0].key, "^ DELETE THIS EXAMPLE ROW BEFORE UPLOADING"]])
  );
  note.font = { italic: true, color: { argb: "FFA85D3F" } };

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="wovenne-${kind.id}-template.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}

async function parseUpload(file: File, kind: ImportKind): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error("That file has no sheets in it.");

  // Headers are matched by NAME, not by position, so a reordered or
  // extra-columned file still works. Case and spacing are ignored because a
  // spreadsheet that has been round-tripped through Numbers or Sheets rarely
  // comes back byte-identical.
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const headerRow = sheet.getRow(1);
  const columnFor = new Map<string, number>();
  headerRow.eachCell((cell, col) => {
    const found = kind.fields.find((f) => normalise(f.header) === normalise(String(cell.value ?? "")));
    if (found) columnFor.set(found.key, col);
  });

  const missing = kind.fields.filter((f) => f.required && !columnFor.has(f.key));
  if (missing.length > 0) {
    throw new Error(
      `That file is missing the ${missing.map((f) => `"${f.header}"`).join(", ")} column. Download the template and start from that.`
    );
  }

  const rows: ParsedRow[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const values: Record<string, string | number | null> = {};
    const errors: string[] = [];

    for (const field of kind.fields) {
      const col = columnFor.get(field.key);
      const raw = col ? cellValue(row.getCell(col)) : null;
      const { value, error } = parseCell(raw, field);
      values[field.key] = value;
      if (error) errors.push(error);
    }

    // Wholly empty rows are the trailing blanks every spreadsheet carries, and
    // the example row the admin forgot to delete leaves one behind when they do.
    const empty = kind.fields.every((f) => values[f.key] === null);
    if (empty) continue;

    rows.push({ row: i, values, errors, action: "skip", summary: "" });
  }

  if (rows.length === 0) throw new Error("That file has no rows in it.");
  return rows;
}

/** ExcelJS wraps formulas and rich text; unwrap to something parseable. */
function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v && typeof v === "object") {
    if ("result" in (v as object)) return (v as { result: unknown }).result;
    if ("richText" in (v as object)) {
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    }
    if ("text" in (v as object)) return (v as { text: unknown }).text;
  }
  return v;
}

/**
 * Decide what each row would do, and say so in words.
 *
 * This is the whole point of the preview: "12 products updated" is not
 * reviewable, "KASAVU-01 cost 1900 → 2100" is.
 */
async function resolveActions(
  supabase: Client,
  kind: ImportKind,
  rows: ParsedRow[]
): Promise<ParsedRow[]> {
  if (kind.id === "products") return resolveProducts(supabase, rows);
  if (kind.id === "courier_costs") return resolveCourier(supabase, rows);
  if (kind.id === "expenses") return resolveExpenses(rows);
  return rows;
}

async function resolveProducts(supabase: Client, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const skus = rows.map((r) => String(r.values.sku ?? "").toUpperCase()).filter(Boolean);
  const { data } = await supabase
    .from("products")
    .select("id, sku, name, price_inr, cost_price_inr, stock_quantity")
    .in("sku", skus);
  const existing = new Map(
    ((data ?? []) as unknown as Record<string, unknown>[]).map((p) => [String(p.sku), p])
  );

  // Slugs of everything already in the catalogue. A new product's slug is
  // derived from its SKU, and a collision would raise mid-commit — AFTER
  // earlier rows had already been written, which is the partial application
  // this import is otherwise careful to avoid. Caught at validation instead,
  // where it is one clear message and nothing has been written.
  const { data: slugRows } = await supabase.from("products").select("slug");
  const takenSlugs = new Set(
    ((slugRows ?? []) as unknown as Record<string, unknown>[]).map((p) =>
      String(p.slug).toLowerCase()
    )
  );

  const seen = new Set<string>();
  for (const row of rows) {
    const sku = String(row.values.sku ?? "").toUpperCase();
    row.values.sku = sku;

    // The same SKU twice in one file: the second would overwrite the first and
    // only one of them is what the admin meant.
    if (seen.has(sku)) {
      row.errors.push(`SKU ${sku} appears more than once in this file`);
      continue;
    }
    seen.add(sku);

    const match = existing.get(sku);
    if (match) {
      row.action = "update";
      const changes: string[] = [];
      for (const [key, label] of [
        ["cost_price_inr", "cost"],
        ["price_inr", "price"],
        ["stock_quantity", "stock"],
      ] as const) {
        const next = row.values[key];
        if (next === null) continue;
        const before = match[key] === null ? "not set" : String(Number(match[key]));
        if (String(next) !== before) changes.push(`${label} ${before} → ${next}`);
      }
      if (row.values.hsn_code !== null) changes.push(`HSN → ${row.values.hsn_code}`);
      row.summary = changes.length
        ? `${match.name}: ${changes.join(", ")}`
        : `${match.name}: nothing to change`;
      if (changes.length === 0) row.action = "skip";
    } else {
      row.action = "create";
      if (!row.values.name) {
        row.errors.push(`SKU ${sku} is new, so it needs a Name`);
      }
      if (row.values.price_inr === null) {
        row.errors.push(`SKU ${sku} is new, so it needs a Selling price`);
      }
      if (takenSlugs.has(sku.toLowerCase())) {
        row.errors.push(
          `SKU ${sku} would clash with an existing product's web address — change the SKU`
        );
      }
      row.summary = `New draft: ${row.values.name ?? "(unnamed)"}`;
    }
  }
  return rows;
}

async function resolveCourier(supabase: Client, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const refs = rows.map((r) => String(r.values.order_ref ?? "")).filter(Boolean);
  const { data } = await supabase
    .from("orders")
    .select("id, invoice_number, razorpay_order_id, courier_actual_cost_inr, customer_name")
    .or(`invoice_number.in.(${refs.join(",")}),razorpay_order_id.in.(${refs.join(",")})`);

  const byRef = new Map<string, Record<string, unknown>>();
  for (const o of ((data ?? []) as unknown as Record<string, unknown>[])) {
    if (o.invoice_number) byRef.set(String(o.invoice_number), o);
    if (o.razorpay_order_id) byRef.set(String(o.razorpay_order_id), o);
  }

  for (const row of rows) {
    const ref = String(row.values.order_ref ?? "");
    const order = byRef.get(ref);
    if (!order) {
      row.errors.push(`No order found for "${ref}"`);
      continue;
    }
    row.action = "update";
    const before =
      order.courier_actual_cost_inr === null
        ? "not recorded"
        : `₹${Number(order.courier_actual_cost_inr)}`;
    row.summary = `${ref} (${order.customer_name ?? "—"}): courier ${before} → ₹${row.values.courier_actual_cost_inr}`;
    // Kept so commit does not have to look it up a second time.
    row.values.__order_id = String(order.id);
  }
  return rows;
}

function resolveExpenses(rows: ParsedRow[]): ParsedRow[] {
  for (const row of rows) {
    const category = String(row.values.category ?? "").toLowerCase().trim();
    if (!isExpenseCategory(category)) {
      row.errors.push(
        `"${row.values.category}" is not a category — use shipping, marketing, software, packaging, rent, salaries or misc`
      );
      continue;
    }
    row.values.category = category;
    row.action = "create";
    row.summary = `${row.values.incurred_on} · ${category} · ₹${row.values.amount_inr}${
      row.values.description ? ` · ${row.values.description}` : ""
    }`;
  }
  return rows;
}

async function commit(supabase: Client, kind: ImportKind, rows: ParsedRow[]): Promise<number> {
  const doing = rows.filter((r) => r.action !== "skip");
  if (kind.id === "expenses") {
    const { error } = await supabase.from("expenses").insert(
      doing.map((r) => ({
        incurred_on: r.values.incurred_on,
        category: r.values.category,
        amount_inr: r.values.amount_inr,
        description: r.values.description,
        vendor: r.values.vendor,
        reference: r.values.reference,
      }))
    );
    if (error) throw new Error(error.message);
    return doing.length;
  }

  if (kind.id === "courier_costs") {
    let applied = 0;
    for (const r of doing) {
      const { data, error } = await supabase
        .from("orders")
        .update({ courier_actual_cost_inr: r.values.courier_actual_cost_inr })
        .eq("id", r.values.__order_id)
        .select("id");
      if (error) throw new Error(error.message);
      // A write RLS refused reports success and changes nothing; counting only
      // the rows that came back means the reported total is the real one.
      applied += data?.length ?? 0;
    }
    return applied;
  }

  if (kind.id === "products") {
    let applied = 0;
    for (const r of doing) {
      // Every product write goes through the draft machinery, exactly as the
      // product form does. Nothing here touches a published row.
      let versionId: string | null = null;
      if (r.action === "create") {
        const { data, error } = await supabase.rpc("create_product_draft");
        if (error) throw new Error(error.message);
        versionId = data as string;
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("id")
          .eq("sku", r.values.sku)
          .maybeSingle();
        if (!product) continue;
        const { data, error } = await supabase.rpc("ensure_product_draft", {
          p_product_id: (product as { id: string }).id,
        });
        if (error) throw new Error(error.message);
        versionId = data as string;
      }
      if (!versionId) continue;

      // Only the fields the file actually filled in. A blank cell leaves the
      // draft's existing value alone — see lib/imports.ts.
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "price_inr", "cost_price_inr", "stock_quantity", "hsn_code"]) {
        if (r.values[key] !== null && r.values[key] !== undefined) patch[key] = r.values[key];
      }
      if (r.action === "create") {
        patch.sku = r.values.sku;
        patch.slug = String(r.values.sku).toLowerCase();
      }
      if (Object.keys(patch).length === 0) continue;

      const { data, error } = await supabase
        .from("product_versions")
        .update(patch)
        .eq("id", versionId)
        .select("id");
      if (error) throw new Error(error.message);
      applied += data?.length ?? 0;
    }
    return applied;
  }

  return 0;
}

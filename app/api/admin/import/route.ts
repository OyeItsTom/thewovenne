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

  if (mode === "template") return template(kind, supabase);

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

/**
 * Dropdown values, read from the database at the moment the template is built.
 *
 * NOT A HARDCODED LIST ANYWHERE. Add a sub-category in the admin and the very
 * next download offers it — there is no second place to update, so the template
 * cannot drift out of step with the catalogue.
 */
async function optionValues(supabase: Client): Promise<Record<string, string[]>> {
  const { data: cats } = await supabase
    .from("categories")
    .select("id, name, parent_id, is_visible")
    .order("sort_order");

  const rows = ((cats ?? []) as unknown as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    name: String(c.name),
    parent: c.parent_id ? String(c.parent_id) : null,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // "Women → Sarees" as one flat list rather than two dependent dropdowns.
  // Dependent lists need INDIRECT and defined names, which Excel honours and
  // Google Sheets and Numbers do not — and a template is opened in whichever of
  // those the person happens to have. A qualified label is unambiguous in all
  // three.
  const categories = rows
    .filter((r) => r.parent !== null)
    .map((r) => `${byId.get(r.parent!)?.name ?? "?"} → ${r.name}`)
    .sort();

  // Colour and material are free text in the schema, so the "list" is whatever
  // has actually been used. Offered as a suggestion, never a restriction.
  const { data: products } = await supabase
    .from("products")
    .select("colour, fabric");
  const distinct = (key: string) =>
    [
      ...new Set(
        ((products ?? []) as unknown as Record<string, unknown>[])
          .map((p) => (p[key] ? String(p[key]).trim() : ""))
          .filter(Boolean)
      ),
    ].sort();

  return {
    categories,
    colours: distinct("colour"),
    fabrics: distinct("fabric"),
  };
}

/** A blank workbook with the right headers, live dropdowns and one example row. */
async function template(kind: ImportKind, supabase: Client) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "THE WOVENNE";
  const sheet = wb.addWorksheet(kind.label.slice(0, 31));
  const options = await optionValues(supabase);

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

  // Dropdowns, applied down the column rather than to one cell, so they still
  // work when the admin pastes or drags a hundred rows in.
  kind.fields.forEach((field, index) => {
    if (!field.options) return;
    const values = options[field.options.source] ?? [];
    if (values.length === 0) return;

    const letter = sheet.getColumn(index + 1).letter;
    for (let row = 2; row <= 500; row++) {
      sheet.getCell(`${letter}${row}`).dataValidation = {
        type: "list",
        allowBlank: !field.required,
        // Inline rather than a range on a hidden sheet: a range needs a defined
        // name to survive a round trip through Sheets or Numbers, and an inline
        // list survives all three unchanged.
        formulae: [`"${values.join(",").replace(/"/g, "")}"`],
        // "suggest" offers the list and still accepts something new — colour
        // and material are free text, and a closed list would refuse a fabric
        // the shop has genuinely started using.
        showErrorMessage: field.options.mode === "strict",
        errorTitle: "Not one of the options",
        error: `Pick a ${field.header.toLowerCase()} from the list.`,
      };
    }
  });

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
  if (kind.id === "products_new") return resolveNewProducts(supabase, rows);
  if (kind.id === "products_update") return resolveProductUpdates(supabase, rows);
  if (kind.id === "courier_costs") return resolveCourier(supabase, rows);
  if (kind.id === "expenses") return resolveExpenses(rows);
  return rows;
}

/**
 * Every row creates a product. SKUs are generated HERE, not typed in Excel.
 *
 * A spreadsheet cannot check uniqueness against a live database while someone
 * types, so a hand-written SKU is a collision discovered at upload — after the
 * work is done. Generated from the name through sku_from_slug(), the same
 * function the database uses when a product is published, then made unique
 * against what actually exists AND against the rest of this file.
 */
async function resolveNewProducts(supabase: Client, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const { data: existing } = await supabase.from("products").select("sku, slug");
  const takenSkus = new Set<string>();
  const takenSlugs = new Set<string>();
  for (const p of ((existing ?? []) as unknown as Record<string, unknown>[])) {
    if (p.sku) takenSkus.add(String(p.sku).toUpperCase());
    if (p.slug) takenSlugs.add(String(p.slug).toLowerCase());
  }

  const { data: cats } = await supabase
    .from("categories")
    .select("id, name, parent_id");
  const catRows = ((cats ?? []) as unknown as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    name: String(c.name),
    parent: c.parent_id ? String(c.parent_id) : null,
  }));
  const byId = new Map(catRows.map((c) => [c.id, c]));
  // Matched on the same "Parent → Child" label the dropdown offers, loosely
  // enough to survive an arrow the admin retyped as a hyphen.
  const labelKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const catByLabel = new Map(
    catRows
      .filter((c) => c.parent)
      .map((c) => [labelKey(`${byId.get(c.parent!)?.name ?? ""}${c.name}`), c.id])
  );

  for (const row of rows) {
    const name = String(row.values.name ?? "").trim();
    const label = String(row.values.category ?? "").trim();

    const categoryId = catByLabel.get(labelKey(label));
    if (!categoryId) {
      row.errors.push(`"${label}" is not one of the categories — use the dropdown in the template`);
    } else {
      row.values.__category_id = categoryId;
    }

    // sku_from_slug's own rule, mirrored: uppercase, non-alphanumerics to
    // hyphens. Kept identical so an imported SKU looks like every other one.
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!base) {
      row.errors.push("Name has no letters or numbers to build a SKU from");
      continue;
    }

    let sku = base;
    let n = 2;
    while (takenSkus.has(sku) || takenSlugs.has(sku.toLowerCase())) {
      sku = `${base}-${n++}`;
    }
    takenSkus.add(sku);
    takenSlugs.add(sku.toLowerCase());

    row.values.sku = sku;
    row.values.__slug = sku.toLowerCase();
    row.action = "create";
    row.summary = `New draft: ${name} · ${label} · SKU ${sku}`;
  }
  return rows;
}

/** Updates only. This template never creates anything. */
async function resolveProductUpdates(supabase: Client, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const skus = rows.map((r) => String(r.values.sku ?? "").toUpperCase()).filter(Boolean);
  const { data } = await supabase
    .from("products")
    .select("id, sku, name, price_inr, cost_price_inr, stock_quantity")
    .in("sku", skus);
  const existing = new Map(
    ((data ?? []) as unknown as Record<string, unknown>[]).map((p) => [String(p.sku), p])
  );

  const seen = new Set<string>();
  for (const row of rows) {
    const sku = String(row.values.sku ?? "").toUpperCase();
    row.values.sku = sku;

    if (seen.has(sku)) {
      row.errors.push(`SKU ${sku} appears more than once in this file`);
      continue;
    }
    seen.add(sku);

    const match = existing.get(sku);
    if (!match) {
      // Never falls through to creating one. A typo'd SKU silently becoming a
      // new product is how a catalogue grows duplicates nobody ordered.
      row.errors.push(`No product with SKU ${sku} — this template only updates`);
      continue;
    }

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
    for (const key of ["fabric", "colour", "hsn_code"] as const) {
      if (row.values[key] !== null) changes.push(`${key} → ${row.values[key]}`);
    }
    row.summary = changes.length
      ? `${match.name}: ${changes.join(", ")}`
      : `${match.name}: nothing to change`;
    if (changes.length === 0) row.action = "skip";
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

  if (kind.id === "products_new" || kind.id === "products_update") {
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
      for (const key of ["name", "price_inr", "cost_price_inr", "stock_quantity", "hsn_code", "fabric", "colour"]) {
        if (r.values[key] !== null && r.values[key] !== undefined) patch[key] = r.values[key];
      }
      if (r.action === "create") {
        patch.sku = r.values.sku;
        patch.slug = r.values.__slug;
        patch.category_id = r.values.__category_id;
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

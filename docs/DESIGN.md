# StockApp Design Reference

The exact schema lives in `electron/db/migrations/*.sql`. This file covers the
rules that the SQL alone does not show.

## Units of storage

| Value         | Storage                          | Example                                |
| ------------- | -------------------------------- | -------------------------------------- |
| Money         | INTEGER paise                    | ₹1,250.50 → `125050`                   |
| Quantity      | INTEGER milli-units (`*_milli`)  | 1.250 kg → `1250`                      |
| Percent (GST) | INTEGER basis points (`*_bp`)    | 18% → `1800`                           |
| Business date | TEXT `YYYY-MM-DD`                | `2026-10-18`                           |
| Timestamp     | TEXT local `YYYY-MM-DD HH:MM:SS` | set by default + `updated_at` triggers |

No floating point is used for money, quantity or tax, in either the DB or the services.
Integer division always goes through `divRound(a, b)`, which rounds half up.

## Bill types and number series

| Bill                       | `bill_type` | Sequence name                | Default prefix   | Printed title                                                |
| -------------------------- | ----------- | ---------------------------- | ---------------- | ------------------------------------------------------------ |
| GST Invoice                | `gst`       | `sale_gst`                   | `GST-`           | "Tax Invoice"                                                |
| Non-GST Bill               | `non_gst`   | `sale_non_gst`               | `EST-`           | setting `non_gst_bill_title` ("Bill of Supply" / "Estimate") |
| Credit note (GST invoice)  | —           | `sale_return_gst`            | `CN-GST-`        | "Credit Note"                                                |
| Credit note (non-GST bill) | —           | `sale_return_non_gst`        | `CN-EST-`        | "Credit Note"                                                |
| Purchase return            | —           | `purchase_return`            | `DN-`            | "Debit Note"                                                 |
| Payment in / out           | —           | `payment_in` / `payment_out` | `RCT-` / `PAY-`  |                                                              |
| Product SKU (auto)         | —           | `product_sku`                | `PC-` (5 digits) | used when SKU is left empty                                  |

- A number is taken from `sequences` inside the same transaction that saves the document.
  If the transaction rolls back, the number is not used up. Once a document is saved, its
  number is never reused, even if the document is cancelled.
- `sales.series` + `sales.seq_no` is UNIQUE. `invoice_no` (prefix + zero-padded number) is UNIQUE too.
  Settings refuses two series with the same prefix.
- **Composition dealer** (setting `composition_dealer = 1`) forces every sale to `non_gst`.
  The bill type toggle is hidden.

## GST rates

- GST rates are rows in `gst_rates` (seed 0, 5, 18, 40). No GST rate is hard-coded in the code.
- Line rows store the numeric `gst_rate_bp` rather than a foreign key, so removing a rate
  later never changes old bills. New lines may only use active rates.

## Line and bill calculation (main process is authoritative)

The renderer shows live totals by calling `sales:calculate` / `purchases:calculate`. Save
recalculates in the main process with the same function (`electron/services/billing.js`).

Per line: `qty_milli`, `rate` (paise per unit, as entered), `discount` (paise), `gst_rate_bp`.

1. `gross = divRound(qty_milli * rate, 1000)`
2. `amount = gross - discount`
3. The bill discount is spread across lines in proportion to `amount`, using largest remainder
   so the shares add up exactly. The result is `net`.
4. Tax (GST bills only; on non-GST bills, tax = 0 and `taxable = net`):
   - **exclusive**: `taxable = net`
   - **inclusive**: `taxable = net - tax`, where tax is calculated on `divRound(net * 10000, 10000 + bp)`
   - same state: `cgst = sgst = divRound(base * bp, 20000)` (equal halves)
   - other state: `igst = divRound(base * bp, 10000)`
5. `line_total = taxable + cgst + sgst + igst`
6. Bill: `grand_total` = the sum of line totals rounded to the nearest rupee (half up).
   `round_off = grand_total - sum`, and it is printed on the invoice.

**Place of supply:** `parties.state_code`, or the business state when it is NULL (for example
Cash Customer). If it equals the setting `business_state_code`, the line uses CGST+SGST;
otherwise it uses IGST. The decision is stored on the document (`is_interstate`,
`place_of_supply_code`).

**GST invoice printing:** the title is "Tax Invoice". The invoice shows the business and customer
GSTIN, HSN per line, the place of supply, and a rate-wise summary (taxable, CGST, SGST/IGST per rate).

## Products, variants and vehicles

- `products` holds what is shared: type (`stock` | `service`), name, category (two levels via
  `product_categories.parent_id`), brand, unit, HSN/SAC, GST rate, price incl./excl. GST,
  compatibility, rack, warranty, image, notes, active.
- `product_variants` is what is stocked and sold: SKU (unique, auto `PC-00001` if empty), barcode
  (unique), colour / size / type, purchase price, MRP, selling price (≤ MRP), min stock, avg cost.
  A product without variants has exactly one variant with empty attributes.
- Stock movements and bill lines reference `variant_id`. Services never get stock movements.
- Compatibility: `products.is_universal = 1`, or rows in `product_vehicles` (vehicle model + optional
  year range). A vehicle filter also matches universal products. These rows are configuration
  and are replaced as a set on save (not business records).
- Removing a variant soft-deletes it, and only when its stock is 0. Products are deactivated, never deleted.
- Stock status per product: `out` if total ≤ 0, `low` if total ≤ sum of min levels (and min > 0), else `in`.
  Stock value = Σ max(stock, 0) × purchase price.
- Import (xlsx/csv): preview first, then all valid products in one transaction. Rows with the same
  Name become variants. Missing categories / sub-categories / `Make: Model` vehicles are created.

## Serial numbers and warranty

- Product settings: `track_serials`, `customer_warranty_months` (default for units sold),
  `supplier_warranty_months` (from purchase date), `warranty_start_basis` ('sale' | 'purchase').
- `product_serials`: one row per unit, never deleted (DB trigger). `serial_key` = upper-case, no
  whitespace; UNIQUE per product. The same number on another product is allowed but warned about.
  `is_auto` marks generated numbers (prefix + 4 digits, numbered after the highest used for that prefix).
- `serial_events`: append-only history of every unit.
- **Invariant:** for tracked variants, `SUM(stock_movements.qty_milli) = 1000 × count(in_stock serials)`.
  Every status change into or out of `in_stock` writes its movement in the same transaction
  (`serials.consistency()` checks it; tests assert it).
- Turning tracking on for stock that exists: exactly one serial per unit (typed, pasted or
  auto-generated); no movement is written. Turning it off: only when no unit is in stock.
- Manual status changes (Serials tab): in_stock → defective / written_off (−1),
  defective → in_stock (+1, repaired) / written_off. Sales, purchases and claims change status
  through their own documents (Phases 4, 5, 5.5).
- Warranty end = start + N calendar months − 1 day, inclusive; if the target month is shorter, the
  last day of that month (31-01 + 1 → 28/29-02). Active through the end date, expired from the next
  day, "expiring" when ≤ 30 days are left (`services/warranty.js`).
- Non-serial items: `sale_items.warranty_months` / `warranty_end` (set in Phase 5) so the Warranty
  page can find them by invoice, customer or vehicle number too.

## Warranty & claims (Phase 5.5)

- **Stock locations:** `stock_movements.location` = `main` (sellable; every stock figure, `v_variant_stock.stock_milli`)
  or `defective` (kept out of sale; `defective_milli`). Serial invariant per variant: SUM(main) = 1000 × `in_stock`
  units and SUM(defective) = 1000 × `defective` units (`serials.consistency()`). Marking defective, repairing, writing
  off, sale returns as defective, purchase returns / cancels of defective units all write their defective-location rows.
  Defective stock is valued at its weighted average (`serials.defectiveUnitCost`).
- **Status is computed, never stored as the only source** (`warranty.unitStatus`): void (warranty voided with a reason,
  sale cancelled, returned) → replaced / refunded (closed by a claim) → under claim (open claim) → active / expiring
  (≤ `warranty_expiring_days`, default 30) / expired. The warranty follows the unit: a claim keeps the original buyer
  and notes a changed vehicle owner / who brought it in.
- **Claims** (`warranty_claims`, WC-0001, sequence `warranty_claim`): kind `customer` (sold serial unit, or a quantity of a
  non-serial bill line) or `stock` (our defective unit sent to the supplier from the Defective list).
  `received → inspecting → repairing | at_supplier | awaiting_replacement → ready → returned → closed`, plus `rejected`
  (unit goes back) and `cancelled` (reason; number kept). Every change is a row in `claim_events`.
  ONE open claim per serial and kind (partial UNIQUE index); non-serial: open claim qty ≤ sold − returned − claimed.
  Out of warranty (expired / void / none) → only as a chargeable repair (`OUT_OF_WARRANTY` until confirmed).
- **Outcomes** (each one transaction: claim, serial status, movements, serial_events, claim_events, money):
  - Repair in shop: in warranty, parts leave stock (`warranty_parts_used` at average cost) and parts + labour are cost;
    chargeable, parts / labour are only noted and the bill (`sales.create` with `claim_id`, pre-filled by
    `claims:billPrefill`) takes the stock out. Hand-over without a bill needs confirming (`NOT_BILLED`).
  - Send to supplier (`claim_dispatches`): a customer unit leaves no stock trace (it was sold), the serial is
    `under_claim`; our defective stock leaves the defective location (`supplier_claim_out`, `sent_value`).
    Results: repaired; replaced (new serial to the customer, linked to the bill line as `is_replacement`, or into stock
    = recovery); credit note (recovery + `v_party_ledger` entry `warranty_credit`, + to the supplier balance); rejected
    (return as is / chargeable / shop absorbs and decides again; a stock unit goes back to defective).
    Overdue = at supplier past `expected_date` (lists, Dashboard, bell).
  - Replace from stock: replacement leaves stock (`warranty_replacement_out` at average cost = loss); the faulty unit
    enters the defective location at **no value** (`warranty_return_in`, so a later write-off is not a second loss)
    unless the supplier already kept it. Replacement warranty: `replacement_warranty` setting (`remaining` = the days
    left on the old unit when the claim was received, counted from the replacement date; `fresh` = full period);
    choosing the other one needs a reason.
  - Refund: a credit note through `saleReturns.create` (`claim_id`; a return outside an open claim is refused);
    the unit / goods go to defective stock; the claim closes.
- **Money** (`warranty_costs`, append-only): cost (replacement, parts, labour, write_off) and recovery
  (supplier_replacement, supplier_credit, repaired_to_stock) at weighted average cost. Net loss = cost − recovery.
- **Prints** (`services/claimPrint.js`): claim slip / job card, rejection slip, handover slip (A4 = customer copy + shop
  copy on one page, or thermal 80 mm), warranty card per bill / unit. PDFs in `data/exports/claims|warranty-cards/<year>/`.
- Settings: `warranty_expiring_days`, `replacement_warranty`, `claim_slip_format`, `claim_terms`, `claim_issue_presets`
  (JSON `{ "<category id>" | "*": [...] }`, added to the built-in complaints per category).

## Files in the data folder

| Path                                        | Contents                                       | Referenced as                                 |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| `data/branding/logo.<png/jpg/svg>`          | custom logo (fixed name; found without the DB) | `app-data://files/branding/logo.png`          |
| `data/branding/startup-sound.<mp3/wav/ogg>` | custom startup sound                           | same scheme                                   |
| `data/images/<random>.<ext>`                | product photos                                 | `products.image_path = 'images/…'` (relative) |

The renderer reads these only through the `app-data://` protocol (`electron/protocol.js`), which
serves `branding/` and `images/` and nothing else. DB backups cover `app.db` only.

## Customers, suppliers and vehicles

- Customers and suppliers are separate rows of `parties` (`type` = `customer` | `supplier`; `both` is
  never written). A firm that is both has two records joined by `linked_party_id` ("Also a supplier");
  their ledgers never mix.
- **Phone:** Indian numbers are stored as 10 national digits (spaces, dashes, brackets, +91 / 0091 /
  0 prefix removed); other countries in E.164 form (`+971501234567`), validated with libphonenumber-js
  (`/max` metadata, bundled, offline). Displayed with the country code: `+91 98765 43210`,
  `+971 50 123 4567`. `components/PhoneInput.jsx` has a country picker (India first), formats as
  you type and refuses digits that do not fit (`phoneDigitsAllowed`: India max 10; elsewhere not
  longer than the country allows and nothing after a complete number). Pasting `+971…` switches
  the country. Indian customers need a mobile (6–9 first); suppliers may use a landline with STD
  code. UNIQUE per type (partial index, ignoring deleted rows). An alternate phone that matches another
  record only warns. Cash Customer (`is_system`) has no phone, no opening balance and no vehicles.
- **GSTIN:** the 15-character format is enforced; a wrong check digit or a state different from the
  party's state only warns. An empty state is filled from the GSTIN. UNIQUE per type.
- **Opening balance:** amount + direction (customer: receivable / advance; supplier: payable / advance),
  stored signed in `opening_balance` with `opening_balance_date`.
- **Plates:** `vehicles.plate_no` is normalised (upper-case letters and digits: `GJ03AB1234`, BH series
  `22BH1234AA`) and UNIQUE in the whole shop. Recognised formats (display / label, `PLATE_FORMATS` in
  `validation/identity.js`): standard `GJ 03 AB 1234` (incl. government series `GJ 18 G 1234`, no series
  `GJ 01 1234`, Delhi class letter `DL 3C AB 1234`), BH `22 BH 1234 AA`, old series `MHU 1234`, defence
  `15 B 123456 K`, diplomatic `77 CD 12`, temporary `T 0124 GJ 1234 AB`, vintage `GJ VA AB 1234`.
  Anything else is accepted as typed with a warning. Make / model use `vehicle_models` (the product compatibility master).
  One primary vehicle per customer (partial unique index).
- **Transfer:** moves `vehicles.customer_id` and closes / opens `vehicle_owners` rows (`from_date`
  inclusive, `to_date` = transfer date, exclusive). Bills and warranties keep the customer who bought
  them; `vehicles.ownerOn(id, date)` answers "who owned it then". Vehicles and ownership rows are never
  deleted (DB triggers).
- **Merge:** one transaction moves every party reference (sales, returns, payments, purchases, serials,
  claims, vehicles, ownership rows), adds the opening balances (earliest as-of date kept), fills the kept
  record's blank fields, soft-deletes the merged record (`merged_into_id`) and appends to `party_merges`.
- **Delete:** soft (`is_deleted = 1`) and only without any document and with zero balance; otherwise
  deactivate. A DB trigger refuses `DELETE` on `parties`.
- **Import:** column mapping → preview → one transaction. Customer rows with the same phone become one
  customer with several vehicles; existing records (by phone, then GSTIN) are skipped or updated (file cells
  that are empty never blank existing values).
- Statements are HTML rendered in a hidden script-less window (temp file in `data/exports/`, removed after)
  and printed or saved as PDF (temp file + rename).

## Ledgers (derived through views, never stored twice)

Party balance sign: **+ = party owes us (receivable)**, **− = we owe party (payable / advance)**.
Views: `v_party_ledger` (one row per entry, with `entry_type`, `ref_no`, signed `amount`) and
`v_party_balance` (SUM per party). No balance column is stored anywhere.

| Source                    | Effect on party balance     |
| ------------------------- | --------------------------- |
| `parties.opening_balance` | as entered (signed)         |
| sale (active)             | + grand_total               |
| sale return               | − total                     |
| payment `in`              | − amount                    |
| payment `out`             | + amount                    |
| purchase (active)         | − grand_total               |
| purchase return           | + total                     |
| supplier warranty credit  | + amount (`warranty_costs`) |

Cash and bank books (`v_account_ledger`): payments in (+), payments out (−), expenses (−),
transfers (− from, + to), plus the account's opening balance.

Cancelled documents (`status = 'cancelled'`) and soft-deleted rows are excluded from every
ledger. Stock movements are append-only; a cancel adds reversing movements.

## Sales (billing)

- **Series:** `sale_gst` (GST-), `sale_non_gst` (EST-), `quotation` (QT-), `sale_return_gst` (CN-GST-),
  `sale_return_non_gst` (CN-EST-). Numbers are taken inside the save transaction (drafts / held bills
  have none). Composition dealer → every sale is `non_gst`, titled "Bill of Supply".
- **Rates:** the default rate is the selling price converted to the bill's mode (`products.price_includes_gst`);
  non-GST bills charge the GST-inclusive price. The customer type's discount becomes a line discount (%).
- **Bill discount** (% or ₹) is spread over all lines (`spread`, by amount after line discounts) BEFORE tax:
  `sale_items.bill_discount_share`. Round-off: auto to the rupee, editable within ±₹1.
- **One save transaction:** header (with customer / vehicle snapshots and `previous_balance`), lines,
  fitting links (`fitting_for_item_id`), `sale` movements at `avg_cost` (frozen in `unit_cost`), serials →
  `sold` (+ `sale_item_serials`, `serial_events`, warranty), split payments (`payments` ref_type `sale` +
  `bill_allocations`), adjust-from-advance allocations, `sale_audit`.
- **Guards:** non-serial stock may not go below zero unless `allow_negative_stock = 1`; serial items never.
  Credit (unpaid) needs a named customer; over the credit limit needs `confirm_credit`; a bill date more
  than 7 days back or in the future needs `confirm_date` (AppError codes `CREDIT_LIMIT` / `DATE_CONFIRM`).
- **Warranty:** non-serial lines: `warranty_start` = bill date, `warranty_end` = `warrantyEnd(start, months)`.
  Serial units: start = bill date, or the unit's purchase date when `warranty_start_basis = 'purchase'`.
- **Fitting:** `products.fitting_variant_id` (a service) + `fitting_charge` (NULL = the service's price,
  0 = free) add a linked fitting line. `fitting_merged` only changes printing.
- **Cancel:** reason required; blocked when the bill has an active credit note, is the new bill of an exchange,
  a sold unit has moved on, or a warranty claim is open. Stock comes back at the original cost (+ movement
  type `sale`), serials back to `in_stock` (warranty cleared), allocations released: money received stays as
  customer advance, or a refund (payment out) is recorded. Cash Customer must be refunded.
  "Cancel & re-issue" opens a new bill with the same lines; it is linked by `sales.reissue_of_id`.
- **Credit notes:** qty ≤ sold − already credited. Each line credits `proportionalLine` of the original
  (taxable and every tax in proportion; the last return of a line takes the exact remainder), so tax is
  reversed at the original rate and value. Stock back at `sale_items.unit_cost` (movement `sale_return`);
  serials to `in_stock` or `defective` (no movement). The credit first reduces that bill's due
  (allocation `sale_return`); the rest is refunded (payment out, ref_type `sale_return`) or kept as advance.
  Fitting lines are refunded only when chosen. Standalone returns (no bill) cannot take serial items.
- **Exchange:** credit note (`settlement = 'exchange'`) + new bill in one transaction; the credit is allocated
  to the new bill. The customer pays only the difference, or the difference is refunded (advance for named
  customers if no refund mode is given).
- **Quotations** use the same validation without stock / payments; converting goes through `sales:prefill`
  (re-checks stock and prices, serials must be picked) and `sales.create({ quotation_id })`.
- **Printing:** HTML in `services/salePrint.js` (A4 + thermal 80 mm), logo embedded as a data URL, UPI QR
  (`services/qr.js`, offline encoder, byte mode, level M) for the amount still due. `print_count > 0` →
  "DUPLICATE". PDFs: `data/exports/invoices|quotations|credit-notes/<year>/<number>[_80mm].pdf`.
- Open bill tabs (max 5) live in renderer memory; "Hold" stores the form in `sale_drafts` (re-checked on resume).

## Cost of goods sold

`products.avg_cost` is the weighted-average cost, updated in the purchase transaction.
`sale_items.unit_cost` freezes it at the time of sale. COGS = Σ `qty × unit_cost` over active
sale lines, minus sale returns.

## IPC channels

Each call is `window.api.invoke(channel, payload)` and returns `{ ok: true, data }` or
`{ ok: false, error: { message, code } }`.

| Module    | Channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app       | `app:info`, `app:startupStatus`, `app:startupProgress` (no DB wait), `app:openDataFolder`, `app:startFresh`, `app:copyText` (no DB wait)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| backup    | `backup:list`, `backup:create`, `backup:restore`, `backup:exportTo`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| products  | `products:meta` (incl. services for the fitting picker), `products:list`, `products:stats`, `products:get`, `products:search`, `products:create`, `products:update`, `products:setActive`, `products:pickImage`, `products:importPreview`, `products:importCommit`, `products:exportXlsx`, `products:template`, `categories:create`, `vehicleModels:create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| stock     | `stock:adjust` (quantity; or `serials` to add / `serial_ids` + `to_status` to remove for tracked items), `stock:ledger`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| serials   | `serials:list`, `serials:get` (with history), `serials:check` (live duplicate check), `serials:previewAuto`, `serials:inStock`, `serials:search`, `serials:setStatus`, `serials:setWarranty`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| warranty  | `warranty:meta`, `warranty:search`, `warranty:unit` `{serial_id / sale_item_id}`, `warranty:list` `{tab: active / expiring / expired, filters}`, `warranty:void`, `warranty:alerts`, `warranty:export`, `warranty:cardHtml/cardPrint/cardPdf` `{sale_id / serial_id / sale_item_id, format}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| claims    | `claims:prepare`, `claims:create`, `claims:get`, `claims:list`, `claims:export`, `claims:inspect`, `claims:decide`, `claims:repairDone`, `claims:dispatch`, `claims:supplierResult`, `claims:replace`, `claims:refund`, `claims:handover`, `claims:close`, `claims:cancel`, `claims:billPrefill`, `claims:forProduct`, `claims:pickPhotos/addAttachments/removeAttachment/openAttachment`, `claims:slipHtml/slipPrint/slipPdf` `{id, doc: slip / rejection / handover, format: a4half / thermal80}`                                                                                                                                                                                                                                                                                                                                                              |
| defective | `defective:list`, `defective:count`, `defective:writeOff`, `defective:repair`, `defective:sendToSupplier`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| parties   | `parties:meta`, `parties:list` (whole filtered list; renderer virtualises), `parties:stats`, `parties:get`, `parties:summary`, `parties:search` (picker / Ctrl+K), `parties:create` (+ vehicles), `parties:update`, `parties:setActive`, `parties:delete` (soft; no history/balance only), `parties:checkDuplicates`, `parties:quickAdd`, `parties:createLinked`, `parties:link`, `parties:unlink`, `parties:mergePreview`, `parties:merge`, `parties:ledger`, `parties:ledgerExport`, `parties:statementPdf`, `parties:statementPrint`, `parties:bills`, `parties:payments`, `parties:purchases`, `parties:warranties`, `parties:claims`, `parties:suppliedProducts`, `parties:exportXlsx`, `parties:importTemplate`, `parties:importOpen`, `parties:importPreview`, `parties:importCommit`, `customerTypes:list`, `customerTypes:save`, `customerTypes:delete` |
| vehicles  | `vehicles:check` (live plate check), `vehicles:create`, `vehicles:update`, `vehicles:setPrimary`, `vehicles:transfer`, `vehicles:history`, `vehicles:remove` (soft; no bills only), `vehicles:compatibleProducts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| purchases | `purchases:list`, `purchases:get`, `purchases:calculate`, `purchases:create`, `purchases:cancel`, `purchaseReturns:create`, `purchaseReturns:list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| sales     | `sales:meta`, `sales:searchItems`, `sales:customerInfo`, `sales:calculate`, `sales:create`, `sales:get`, `sales:list`, `sales:stats`, `sales:recent`, `sales:cancel`, `sales:prefill` `{sale_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | quotation_id}`, `sales:recordPayment`, `sales:previewHtml`/`sales:print`/`sales:savePdf` `{id, format: a4 | thermal80}`, `sales:showFile`, `saleDrafts:list/get/save/discard`, `quotations:create/get/list/cancel/previewHtml/print/savePdf`, `saleReturns:find/prepare/calculate/create/exchange/get/list/previewHtml/print/savePdf` |
| accounts  | `accounts:list`, `accounts:book`, `transfers:create`, `payments:list`, `payments:create`, `payments:cancel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| expenses  | `expenses:list`, `expenses:create`, `expenses:update`, `expenses:cancel`, `expenseCategories:list`, `expenseCategories:create`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| reports   | `reports:sales`, `reports:purchases`, `reports:stockSummary`, `reports:stockLedger`, `reports:partyLedger`, `reports:outstanding`, `reports:expenses`, `reports:profitLoss`, `reports:dayBook`, `reports:gstSales`, `reports:gstPurchases`, `reports:gstRateSummary`, `reports:export` `{report, params, format: csv\|xlsx\|pdf}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| dashboard | `dashboard:summary`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| settings  | `settings:get`, `settings:update`, `sequences:list`, `sequences:update`, `gstRates:list`, `gstRates:create`, `gstRates:delete`, `meta:states`, `pin:set`, `pin:verify`, `pin:clear`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| prefs     | `prefs:get`, `prefs:set` (settings.json UI prefs; no DB wait)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| branding  | `branding:get`, `branding:pickLogo`, `branding:resetLogo`, `branding:pickSound`, `branding:resetSound`, `branding:setWindowIcon` (all no DB wait)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Report params accept `{ from, to, billType: 'gst' | 'non_gst' | 'all' }` where relevant.

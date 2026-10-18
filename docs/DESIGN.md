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

| Bill             | `bill_type` | Sequence name                | Default prefix  | Printed title                                                |
| ---------------- | ----------- | ---------------------------- | --------------- | ------------------------------------------------------------ |
| GST Invoice      | `gst`       | `sale_gst`                   | `GST-`          | "Tax Invoice"                                                |
| Non-GST Bill     | `non_gst`   | `sale_non_gst`               | `EST-`          | setting `non_gst_bill_title` ("Bill of Supply" / "Estimate") |
| Sale return      | —           | `sale_return`                | `CN-`           | "Credit Note"                                                |
| Purchase return  | —           | `purchase_return`            | `DN-`           | "Debit Note"                                                 |
| Payment in / out | —           | `payment_in` / `payment_out` | `RCT-` / `PAY-` |                                                              |

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

## Ledgers (derived through views, never stored twice)

Party balance sign: **+ = party owes us (receivable)**, **− = we owe party (payable / advance)**.

| Source                    | Effect on party balance |
| ------------------------- | ----------------------- |
| `parties.opening_balance` | as entered (signed)     |
| sale (active)             | + grand_total           |
| sale return               | − total                 |
| payment `in`              | − amount                |
| payment `out`             | + amount                |
| purchase (active)         | − grand_total           |
| purchase return           | + total                 |

Cash and bank books (`v_account_ledger`): payments in (+), payments out (−), expenses (−),
transfers (− from, + to), plus the account's opening balance.

Cancelled documents (`status = 'cancelled'`) and soft-deleted rows are excluded from every
ledger. Stock movements are append-only; a cancel adds reversing movements.

## Cost of goods sold

`products.avg_cost` is the weighted-average cost, updated in the purchase transaction.
`sale_items.unit_cost` freezes it at the time of sale. COGS = Σ `qty × unit_cost` over active
sale lines, minus sale returns.

## IPC channels

Each call is `window.api.invoke(channel, payload)` and returns `{ ok: true, data }` or
`{ ok: false, error: { message, code } }`.

| Module    | Channels                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app       | `app:info`, `app:startupStatus`, `app:openDataFolder`, `app:startFresh`                                                                                                                                                                                                                                                           |
| backup    | `backup:list`, `backup:create`, `backup:restore`, `backup:exportTo`                                                                                                                                                                                                                                                               |
| products  | `products:list`, `products:get`, `products:search`, `products:create`, `products:update`, `products:delete`, `categories:list`, `categories:create`                                                                                                                                                                               |
| stock     | `stock:adjust`, `stock:ledger`, `stock:summary`, `stock:lowStock`                                                                                                                                                                                                                                                                 |
| parties   | `parties:list`, `parties:get`, `parties:search`, `parties:create`, `parties:update`, `parties:delete`, `parties:ledger`, `parties:balance`                                                                                                                                                                                        |
| purchases | `purchases:list`, `purchases:get`, `purchases:calculate`, `purchases:create`, `purchases:cancel`, `purchaseReturns:create`, `purchaseReturns:list`                                                                                                                                                                                |
| sales     | `sales:list`, `sales:get`, `sales:calculate`, `sales:nextInvoiceNo` `{billType}`, `sales:create`, `sales:cancel`, `sales:print` `{id, format: a4\|thermal80}`, `sales:savePdf`, `saleReturns:create`, `saleReturns:list`                                                                                                          |
| accounts  | `accounts:list`, `accounts:book`, `transfers:create`, `payments:list`, `payments:create`, `payments:cancel`                                                                                                                                                                                                                       |
| expenses  | `expenses:list`, `expenses:create`, `expenses:update`, `expenses:cancel`, `expenseCategories:list`, `expenseCategories:create`                                                                                                                                                                                                    |
| reports   | `reports:sales`, `reports:purchases`, `reports:stockSummary`, `reports:stockLedger`, `reports:partyLedger`, `reports:outstanding`, `reports:expenses`, `reports:profitLoss`, `reports:dayBook`, `reports:gstSales`, `reports:gstPurchases`, `reports:gstRateSummary`, `reports:export` `{report, params, format: csv\|xlsx\|pdf}` |
| dashboard | `dashboard:summary`                                                                                                                                                                                                                                                                                                               |
| settings  | `settings:get`, `settings:update`, `settings:setLogo`, `gstRates:list`, `gstRates:create`, `gstRates:update`, `gstRates:delete`, `meta:states`, `pin:set`, `pin:verify`, `pin:clear`                                                                                                                                              |

Report params accept `{ from, to, billType: 'gst' | 'non_gst' | 'all' }` where relevant.

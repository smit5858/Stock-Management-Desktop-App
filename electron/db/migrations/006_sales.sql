-- foreign_keys: off
-- 006_sales: billing (Phase 5): sales, credit notes, quotations, held bills, sale audit,
-- fitting defaults on products and 'card' payments.
-- Rebuilds the sales tables from 001 (never written before this version) and payments (new
-- 'card' mode) with SQLite's 12-step procedure: create new table, copy, drop old, rename.
-- migrate.js runs this file with foreign_keys OFF inside one transaction, then runs
-- foreign_key_check + integrity_check before COMMIT. A backup is taken just before.

-- Views read the tables being rebuilt; they are recreated at the end.
DROP VIEW v_party_balance;
DROP VIEW v_party_ledger;

-- ---------------------------------------------------------------- sales (invoices / bills)
CREATE TABLE sales_new (
  id                    INTEGER PRIMARY KEY,
  invoice_no            TEXT NOT NULL UNIQUE,              -- prefix + padded seq_no: GST-0001
  series                TEXT NOT NULL,                     -- sale_gst | sale_non_gst
  seq_no                INTEGER NOT NULL,
  invoice_date          TEXT NOT NULL,
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  price_mode            TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')),
  bill_title            TEXT NOT NULL,                     -- Tax Invoice / Bill of Supply / Estimate
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  customer_name         TEXT NOT NULL,                     -- snapshots for reprinting
  customer_phone        TEXT,
  customer_address      TEXT,
  customer_gstin        TEXT,
  customer_state_code   TEXT,
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  vehicle_id            INTEGER REFERENCES vehicles(id),
  vehicle_no            TEXT,                              -- as printed: GJ 03 AB 1234
  vehicle_no_key        TEXT,                              -- GJ03AB1234 (search)
  vehicle_model         TEXT,                              -- "Maruti Suzuki Swift"
  sub_total             INTEGER NOT NULL DEFAULT 0,        -- Σ qty × rate
  item_discount_total   INTEGER NOT NULL DEFAULT 0,        -- Σ line discounts
  bill_discount_bp      INTEGER CHECK (bill_discount_bp IS NULL OR bill_discount_bp BETWEEN 0 AND 10000),
  bill_discount         INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  taxable_total         INTEGER NOT NULL DEFAULT 0,
  cgst_total            INTEGER NOT NULL DEFAULT 0,
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -100 AND 100),
  grand_total           INTEGER NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  goods_total           INTEGER NOT NULL DEFAULT 0,        -- Σ line totals of products
  services_total        INTEGER NOT NULL DEFAULT 0,        -- Σ line totals of fitting / labour
  cost_total            INTEGER NOT NULL DEFAULT 0,        -- Σ qty × unit_cost (COGS at sale)
  previous_balance      INTEGER NOT NULL DEFAULT 0,        -- customer balance before this bill
  due_date              TEXT,
  quotation_id          INTEGER REFERENCES quotations(id), -- converted from
  reissue_of_id         INTEGER REFERENCES sales(id),      -- "cancel & re-issue": the cancelled bill
  print_count           INTEGER NOT NULL DEFAULT 0,        -- > 0: reprints say DUPLICATE
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  notes                 TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
INSERT INTO sales_new (id, invoice_no, series, seq_no, invoice_date, bill_type, price_mode, bill_title,
  party_id, customer_name, customer_phone, customer_address, customer_gstin, place_of_supply_code,
  is_interstate, vehicle_id, vehicle_no, vehicle_no_key, vehicle_model, sub_total, item_discount_total,
  bill_discount, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total,
  status, cancel_reason, cancelled_at, notes, is_deleted, created_at, updated_at)
SELECT id, invoice_no, series, seq_no, invoice_date, bill_type, price_mode, bill_title, party_id,
  COALESCE(customer_name, ''), customer_phone, customer_address, customer_gstin, place_of_supply_code,
  is_interstate, vehicle_id, vehicle_no, vehicle_no_key, vehicle_model, sub_total, item_discount_total,
  bill_discount, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total,
  status, cancel_reason, cancelled_at, notes, is_deleted, created_at, updated_at
FROM sales;
DROP TABLE sales;
ALTER TABLE sales_new RENAME TO sales;
CREATE INDEX ix_sales_date ON sales(invoice_date);
CREATE INDEX ix_sales_party ON sales(party_id, invoice_date);
CREATE INDEX ix_sales_type_date ON sales(bill_type, invoice_date);
CREATE INDEX ix_sales_vehicle ON sales(vehicle_no_key);
CREATE INDEX ix_sales_vehicle_id ON sales(vehicle_id);
CREATE INDEX ix_sales_due ON sales(due_date) WHERE status = 'active';

-- ---------------------------------------------------------------- sale lines
-- A fitting line points to the product line it belongs to (fitting_for_item_id). Services
-- (fitting / labour) never get stock movements.
CREATE TABLE sale_items_new (
  id                   INTEGER PRIMARY KEY,
  sale_id              INTEGER NOT NULL REFERENCES sales(id),
  product_id           INTEGER NOT NULL REFERENCES products(id),
  variant_id           INTEGER NOT NULL REFERENCES product_variants(id),
  item_type            TEXT NOT NULL DEFAULT 'goods' CHECK (item_type IN ('goods','service')),
  product_name         TEXT NOT NULL,                    -- snapshots for reprinting
  variant_label        TEXT,
  sku                  TEXT,
  unit                 TEXT NOT NULL,
  hsn_code             TEXT,
  qty_milli            INTEGER NOT NULL CHECK (qty_milli > 0),
  rate                 INTEGER NOT NULL CHECK (rate >= 0),       -- per unit, as entered
  mrp                  INTEGER NOT NULL DEFAULT 0,
  discount_bp          INTEGER CHECK (discount_bp IS NULL OR discount_bp BETWEEN 0 AND 10000),
  discount             INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),  -- line discount, paise
  bill_discount_share  INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount_share >= 0),
  gst_rate_bp          INTEGER NOT NULL DEFAULT 0,
  taxable              INTEGER NOT NULL,
  cgst                 INTEGER NOT NULL DEFAULT 0,
  sgst                 INTEGER NOT NULL DEFAULT 0,
  igst                 INTEGER NOT NULL DEFAULT 0,
  line_total           INTEGER NOT NULL,
  unit_cost            INTEGER NOT NULL DEFAULT 0,       -- avg_cost at time of sale (COGS)
  warranty_months      INTEGER NOT NULL DEFAULT 0 CHECK (warranty_months BETWEEN 0 AND 240),
  warranty_start       TEXT,
  warranty_end         TEXT,                             -- inclusive; NULL = no warranty
  fitting_for_item_id  INTEGER REFERENCES sale_items(id),
  fitting_merged       INTEGER NOT NULL DEFAULT 0 CHECK (fitting_merged IN (0,1)),  -- print only
  fitted_by            TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO sale_items_new (id, sale_id, product_id, variant_id, product_name, variant_label, unit,
  hsn_code, qty_milli, rate, discount, gst_rate_bp, taxable, cgst, sgst, igst, line_total, unit_cost,
  warranty_months, warranty_end, sort_order, created_at, updated_at)
SELECT id, sale_id, product_id, variant_id, product_name, variant_label, unit, hsn_code, qty_milli,
  rate, discount, gst_rate_bp, taxable, cgst, sgst, igst, line_total, unit_cost, warranty_months,
  warranty_end, sort_order, created_at, updated_at
FROM sale_items;
DROP TABLE sale_items;
ALTER TABLE sale_items_new RENAME TO sale_items;
CREATE INDEX ix_sale_items_sale ON sale_items(sale_id, sort_order);
CREATE INDEX ix_sale_items_variant ON sale_items(variant_id);
CREATE INDEX ix_sale_items_product ON sale_items(product_id);
CREATE INDEX ix_sale_items_warranty ON sale_items(warranty_end);
CREATE INDEX ix_sale_items_fitting ON sale_items(fitting_for_item_id);
CREATE INDEX ix_sale_items_fitted_by ON sale_items(fitted_by) WHERE fitted_by IS NOT NULL;

-- Serial numbers sold on a line, with the warranty given for each unit. Kept after a return /
-- cancel (status) so the bill always shows what was sold. product_serials.sale_* point to the
-- current sale of the unit only.
CREATE TABLE sale_item_serials (
  id                   INTEGER PRIMARY KEY,
  sale_item_id         INTEGER NOT NULL REFERENCES sale_items(id),
  serial_id            INTEGER NOT NULL REFERENCES product_serials(id),
  warranty_start       TEXT,
  warranty_end         TEXT,
  status               TEXT NOT NULL DEFAULT 'sold' CHECK (status IN ('sold','returned','cancelled')),
  sale_return_item_id  INTEGER REFERENCES sale_return_items(id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (sale_item_id, serial_id)
);
CREATE INDEX ix_sale_item_serials_serial ON sale_item_serials(serial_id);

-- ---------------------------------------------------------------- sale returns (credit notes)
CREATE TABLE sale_returns_new (
  id                    INTEGER PRIMARY KEY,
  return_no             TEXT NOT NULL UNIQUE,              -- CN-GST-0001 / CN-EST-0001
  series                TEXT NOT NULL,                     -- sale_return_gst | sale_return_non_gst
  seq_no                INTEGER NOT NULL,
  sale_id               INTEGER REFERENCES sales(id),      -- NULL = standalone
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  customer_name         TEXT NOT NULL,
  customer_phone        TEXT,
  customer_gstin        TEXT,
  date                  TEXT NOT NULL,
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),  -- from the sale
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  taxable_total         INTEGER NOT NULL DEFAULT 0,
  cgst_total            INTEGER NOT NULL DEFAULT 0,
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  settlement            TEXT NOT NULL DEFAULT 'adjust' CHECK (settlement IN ('adjust','refund','exchange')),
  exchange_sale_id      INTEGER REFERENCES sales(id),      -- the new bill of an exchange
  reason                TEXT,
  print_count           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
INSERT INTO sale_returns_new (id, return_no, series, seq_no, sale_id, party_id, customer_name, date,
  bill_type, place_of_supply_code, is_interstate, taxable_total, cgst_total, sgst_total, igst_total,
  tax_total, round_off, total, reason, status, cancel_reason, cancelled_at, is_deleted, created_at,
  updated_at)
SELECT o.id, o.return_no, 'sale_return_' || o.bill_type, -o.id, o.sale_id, o.party_id,
  COALESCE(p.name, ''), o.date, o.bill_type, '', o.is_interstate, o.taxable_total, o.cgst_total,
  o.sgst_total, o.igst_total, o.tax_total, o.round_off, o.total, o.reason, o.status, o.cancel_reason,
  o.cancelled_at, o.is_deleted, o.created_at, o.updated_at
FROM sale_returns o LEFT JOIN parties p ON p.id = o.party_id;
DROP TABLE sale_returns;
ALTER TABLE sale_returns_new RENAME TO sale_returns;
CREATE INDEX ix_sale_returns_date ON sale_returns(date);
CREATE INDEX ix_sale_returns_party ON sale_returns(party_id);
CREATE INDEX ix_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE sale_return_items_new (
  id              INTEGER PRIMARY KEY,
  sale_return_id  INTEGER NOT NULL REFERENCES sale_returns(id),
  sale_item_id    INTEGER REFERENCES sale_items(id),      -- NULL = standalone return
  product_id      INTEGER NOT NULL REFERENCES products(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  item_type       TEXT NOT NULL DEFAULT 'goods' CHECK (item_type IN ('goods','service')),
  product_name    TEXT NOT NULL,
  variant_label   TEXT,
  unit            TEXT NOT NULL,
  hsn_code        TEXT,
  qty_milli       INTEGER NOT NULL CHECK (qty_milli > 0),
  rate            INTEGER NOT NULL CHECK (rate >= 0),     -- taxable value per unit
  gst_rate_bp     INTEGER NOT NULL DEFAULT 0,
  taxable         INTEGER NOT NULL,
  cgst            INTEGER NOT NULL DEFAULT 0,
  sgst            INTEGER NOT NULL DEFAULT 0,
  igst            INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  unit_cost       INTEGER NOT NULL DEFAULT 0,             -- the original sale cost (stock value)
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO sale_return_items_new (id, sale_return_id, sale_item_id, product_id, variant_id,
  product_name, unit, qty_milli, rate, gst_rate_bp, taxable, cgst, sgst, igst, line_total, unit_cost,
  created_at, updated_at)
SELECT r.id, r.sale_return_id, r.sale_item_id, r.product_id, r.variant_id, COALESCE(p.name, ''),
  COALESCE(p.unit, 'pcs'), r.qty_milli, r.rate, r.gst_rate_bp, r.taxable, r.cgst, r.sgst, r.igst,
  r.line_total, r.unit_cost, r.created_at, r.updated_at
FROM sale_return_items r LEFT JOIN products p ON p.id = r.product_id;
DROP TABLE sale_return_items;
ALTER TABLE sale_return_items_new RENAME TO sale_return_items;
CREATE INDEX ix_sale_return_items_return ON sale_return_items(sale_return_id);
CREATE INDEX ix_sale_return_items_item ON sale_return_items(sale_item_id);
CREATE INDEX ix_sale_return_items_variant ON sale_return_items(variant_id);

CREATE TABLE sale_return_serials (
  id                   INTEGER PRIMARY KEY,
  sale_return_item_id  INTEGER NOT NULL REFERENCES sale_return_items(id),
  serial_id            INTEGER NOT NULL REFERENCES product_serials(id),
  to_status            TEXT NOT NULL CHECK (to_status IN ('in_stock','defective')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_return_serials_item ON sale_return_serials(sale_return_item_id);
CREATE INDEX ix_sale_return_serials_serial ON sale_return_serials(serial_id);

-- ---------------------------------------------------------------- quotations (no stock / ledger effect)
CREATE TABLE quotations (
  id                    INTEGER PRIMARY KEY,
  quote_no              TEXT NOT NULL UNIQUE,              -- QT-0001
  series                TEXT NOT NULL DEFAULT 'quotation',
  seq_no                INTEGER NOT NULL,
  quote_date            TEXT NOT NULL,
  valid_till            TEXT NOT NULL,
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  price_mode            TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')),
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  customer_name         TEXT NOT NULL,
  customer_phone        TEXT,
  customer_address      TEXT,
  customer_gstin        TEXT,
  customer_state_code   TEXT,
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  vehicle_id            INTEGER REFERENCES vehicles(id),
  vehicle_no            TEXT,
  vehicle_no_key        TEXT,
  vehicle_model         TEXT,
  sub_total             INTEGER NOT NULL DEFAULT 0,
  item_discount_total   INTEGER NOT NULL DEFAULT 0,
  bill_discount_bp      INTEGER CHECK (bill_discount_bp IS NULL OR bill_discount_bp BETWEEN 0 AND 10000),
  bill_discount         INTEGER NOT NULL DEFAULT 0,
  taxable_total         INTEGER NOT NULL DEFAULT 0,
  cgst_total            INTEGER NOT NULL DEFAULT 0,
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -100 AND 100),
  grand_total           INTEGER NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  goods_total           INTEGER NOT NULL DEFAULT 0,
  services_total        INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  converted_sale_id     INTEGER REFERENCES sales(id),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  notes                 TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
CREATE INDEX ix_quotations_date ON quotations(quote_date);
CREATE INDEX ix_quotations_party ON quotations(party_id);

CREATE TABLE quotation_items (
  id                   INTEGER PRIMARY KEY,
  quotation_id         INTEGER NOT NULL REFERENCES quotations(id),
  product_id           INTEGER NOT NULL REFERENCES products(id),
  variant_id           INTEGER NOT NULL REFERENCES product_variants(id),
  item_type            TEXT NOT NULL DEFAULT 'goods' CHECK (item_type IN ('goods','service')),
  product_name         TEXT NOT NULL,
  variant_label        TEXT,
  sku                  TEXT,
  unit                 TEXT NOT NULL,
  hsn_code             TEXT,
  qty_milli            INTEGER NOT NULL CHECK (qty_milli > 0),
  rate                 INTEGER NOT NULL CHECK (rate >= 0),
  mrp                  INTEGER NOT NULL DEFAULT 0,
  discount_bp          INTEGER CHECK (discount_bp IS NULL OR discount_bp BETWEEN 0 AND 10000),
  discount             INTEGER NOT NULL DEFAULT 0,
  bill_discount_share  INTEGER NOT NULL DEFAULT 0,
  gst_rate_bp          INTEGER NOT NULL DEFAULT 0,
  taxable              INTEGER NOT NULL,
  cgst                 INTEGER NOT NULL DEFAULT 0,
  sgst                 INTEGER NOT NULL DEFAULT 0,
  igst                 INTEGER NOT NULL DEFAULT 0,
  line_total           INTEGER NOT NULL,
  warranty_months      INTEGER NOT NULL DEFAULT 0,
  fitting_for_item_id  INTEGER REFERENCES quotation_items(id),
  fitting_merged       INTEGER NOT NULL DEFAULT 0 CHECK (fitting_merged IN (0,1)),
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_quotation_items_quotation ON quotation_items(quotation_id, sort_order);

-- ---------------------------------------------------------------- held bills (drafts)
-- The whole billing form as JSON ({ v: <draft schema version>, ... }). No stock or ledger effect.
CREATE TABLE sale_drafts (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill','quotation')),
  party_id       INTEGER REFERENCES parties(id),
  customer_name  TEXT,
  vehicle_no     TEXT,
  item_count     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','saved','discarded')),
  sale_id        INTEGER REFERENCES sales(id),
  quotation_id   INTEGER REFERENCES quotations(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_drafts_status ON sale_drafts(status, updated_at);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE sale_audit (
  id              INTEGER PRIMARY KEY,
  sale_id         INTEGER REFERENCES sales(id),
  sale_return_id  INTEGER REFERENCES sale_returns(id),
  quotation_id    INTEGER REFERENCES quotations(id),
  action          TEXT NOT NULL CHECK (action IN ('created','cancelled','payment','refund','return',
                    'exchange','printed','pdf','quotation_created','quotation_cancelled',
                    'quotation_converted')),
  actor           TEXT NOT NULL,        -- computer name until users / PIN (Phase 8)
  summary         TEXT NOT NULL,
  details         TEXT,                 -- JSON
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_audit_sale ON sale_audit(sale_id, id);
CREATE INDEX ix_sale_audit_return ON sale_audit(sale_return_id, id);
CREATE INDEX ix_sale_audit_quotation ON sale_audit(quotation_id, id);

-- ---------------------------------------------------------------- payments: 'card' mode
CREATE TABLE payments_new (
  id             INTEGER PRIMARY KEY,
  payment_no     TEXT NOT NULL UNIQUE,
  date           TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_id       INTEGER REFERENCES parties(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  ref_type       TEXT NOT NULL DEFAULT 'on_account' CHECK (ref_type IN
                   ('sale','purchase','sale_return','purchase_return','on_account')),
  ref_id         INTEGER,
  mode           TEXT CHECK (mode IS NULL OR mode IN ('cash','upi','card','bank','cheque')),
  ref_no         TEXT,                  -- cheque no. / UTR / card slip
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO payments_new (id, payment_no, date, direction, party_id, account_id, amount, ref_type, ref_id,
  mode, ref_no, notes, status, cancel_reason, cancelled_at, is_deleted, created_at, updated_at)
SELECT id, payment_no, date, direction, party_id, account_id, amount, ref_type, ref_id, mode, ref_no,
  notes, status, cancel_reason, cancelled_at, is_deleted, created_at, updated_at
FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX ix_payments_date ON payments(date);
CREATE INDEX ix_payments_party ON payments(party_id);
CREATE INDEX ix_payments_account ON payments(account_id, date);
CREATE INDEX ix_payments_ref ON payments(ref_type, ref_id);
CREATE INDEX ix_payments_mode_date ON payments(mode, date) WHERE status = 'active';

-- ---------------------------------------------------------------- products: fitting defaults
-- fitting_variant_id: a service (fitting / installation) added below the product on a bill.
-- fitting_charge: NULL = the service's selling price; 0 = free fitting.
ALTER TABLE products ADD COLUMN fitting_variant_id INTEGER REFERENCES product_variants(id);
ALTER TABLE products ADD COLUMN fitting_charge INTEGER CHECK (fitting_charge IS NULL OR fitting_charge >= 0);

-- ---------------------------------------------------------------- number series & settings
INSERT INTO sequences (name, prefix, pad_width) VALUES ('quotation', 'QT-', 4);

INSERT INTO settings (key, value) VALUES
  ('allow_negative_stock', '0'),        -- 1 = non-serial items may be sold below zero
  ('print_format', 'a4'),               -- a4 | thermal80 (default; can switch at print time)
  ('thermal_silent_print', '0'),        -- 1 = thermal prints go to the default printer directly
  ('invoice_terms', 'Goods once sold will not be taken back without the bill.
Warranty as per the manufacturer''s terms.'),
  ('print_previous_balance', '0'),      -- 1 = print "Previous balance" and "Total due"
  ('upi_id', ''),                       -- UPI QR on invoices (e.g. pragaticar@okaxis)
  ('quotation_valid_days', '7');

-- ---------------------------------------------------------------- views
-- Sign: + = party owes us (receivable), - = we owe the party (payable / advance).
CREATE VIEW v_party_ledger AS
  SELECT p.id AS party_id, COALESCE(p.opening_balance_date, substr(p.created_at, 1, 10)) AS date,
    'opening' AS entry_type, NULL AS ref_id, NULL AS ref_no, p.opening_balance AS amount,
    '0' AS sort_key
  FROM parties p WHERE p.is_deleted = 0 AND p.opening_balance <> 0
  UNION ALL
  SELECT s.party_id, s.invoice_date, 'sale', s.id, s.invoice_no, s.grand_total, '1' || s.created_at
  FROM sales s WHERE s.status = 'active' AND s.is_deleted = 0
  UNION ALL
  SELECT r.party_id, r.date, 'sale_return', r.id, r.return_no, -r.total, '1' || r.created_at
  FROM sale_returns r WHERE r.status = 'active' AND r.is_deleted = 0
  UNION ALL
  SELECT pm.party_id, pm.date, CASE pm.direction WHEN 'in' THEN 'payment_in' ELSE 'payment_out' END,
    pm.id, pm.payment_no, CASE pm.direction WHEN 'in' THEN -pm.amount ELSE pm.amount END,
    '1' || pm.created_at
  FROM payments pm WHERE pm.party_id IS NOT NULL AND pm.status = 'active' AND pm.is_deleted = 0
  UNION ALL
  SELECT pu.party_id, pu.bill_date, 'purchase', pu.id,
    pu.entry_no || CASE WHEN pu.bill_no IS NOT NULL AND pu.bill_no <> '' THEN ' / ' || pu.bill_no ELSE '' END,
    -pu.grand_total, '1' || pu.created_at
  FROM purchases pu WHERE pu.status = 'active' AND pu.is_deleted = 0
  UNION ALL
  SELECT pr.party_id, pr.date, 'purchase_return', pr.id, pr.return_no, pr.total, '1' || pr.created_at
  FROM purchase_returns pr WHERE pr.status = 'active' AND pr.is_deleted = 0;

CREATE VIEW v_party_balance AS
  SELECT party_id, SUM(amount) AS balance FROM v_party_ledger GROUP BY party_id;

-- Paid / due per active sale. pay_status: paid | partial | unpaid | overdue.
CREATE VIEW v_sale_dues AS
  SELECT t.*, t.grand_total - t.paid AS due,
    CASE
      WHEN t.grand_total - t.paid <= 0 THEN 'paid'
      WHEN t.due_date IS NOT NULL AND t.due_date < date('now','localtime') THEN 'overdue'
      WHEN t.paid > 0 THEN 'partial'
      ELSE 'unpaid'
    END AS pay_status
  FROM (
    SELECT s.id AS sale_id, s.party_id, s.grand_total, s.due_date,
      COALESCE((SELECT SUM(a.amount) FROM bill_allocations a
        WHERE a.doc_type = 'sale' AND a.doc_id = s.id AND a.status = 'active'), 0) AS paid
    FROM sales s WHERE s.status = 'active' AND s.is_deleted = 0
  ) t;

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER trg_sales_updated AFTER UPDATE ON sales FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sales SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sale_items_updated AFTER UPDATE ON sale_items FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sale_items SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sale_item_serials_updated AFTER UPDATE ON sale_item_serials FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sale_item_serials SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sale_returns_updated AFTER UPDATE ON sale_returns FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sale_returns SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_quotations_updated AFTER UPDATE ON quotations FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE quotations SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sale_drafts_updated AFTER UPDATE ON sale_drafts FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sale_drafts SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_payments_updated AFTER UPDATE ON payments FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE payments SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER trg_sales_no_delete BEFORE DELETE ON sales
  BEGIN SELECT RAISE(ABORT, 'sales are never deleted'); END;
CREATE TRIGGER trg_sale_items_no_delete BEFORE DELETE ON sale_items
  BEGIN SELECT RAISE(ABORT, 'sale lines are never deleted'); END;
CREATE TRIGGER trg_sale_item_serials_no_delete BEFORE DELETE ON sale_item_serials
  BEGIN SELECT RAISE(ABORT, 'sold serial records are never deleted'); END;
CREATE TRIGGER trg_sale_returns_no_delete BEFORE DELETE ON sale_returns
  BEGIN SELECT RAISE(ABORT, 'sale returns are never deleted'); END;
CREATE TRIGGER trg_sale_return_items_no_delete BEFORE DELETE ON sale_return_items
  BEGIN SELECT RAISE(ABORT, 'sale return lines are never deleted'); END;
CREATE TRIGGER trg_quotations_no_delete BEFORE DELETE ON quotations
  BEGIN SELECT RAISE(ABORT, 'quotations are never deleted'); END;
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
  BEGIN SELECT RAISE(ABORT, 'payments are never deleted'); END;
CREATE TRIGGER trg_sale_audit_no_update BEFORE UPDATE ON sale_audit
  BEGIN SELECT RAISE(ABORT, 'sale_audit is append-only'); END;
CREATE TRIGGER trg_sale_audit_no_delete BEFORE DELETE ON sale_audit
  BEGIN SELECT RAISE(ABORT, 'sale_audit is append-only'); END;

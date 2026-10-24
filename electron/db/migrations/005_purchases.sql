-- foreign_keys: off
-- 005_purchases: purchase entry, purchase returns (debit notes), supplier payables (Phase 4).
-- Rebuilds the purchase tables from 001 (never used before this version) and product_serials
-- (new 'voided' status), using SQLite's 12-step procedure: create new table, copy, drop old,
-- rename. migrate.js runs this file with foreign_keys OFF inside one transaction, then runs
-- foreign_key_check + integrity_check before COMMIT. A backup is taken just before.

-- Views read the tables being rebuilt; they are recreated at the end.
DROP VIEW v_party_balance;
DROP VIEW v_party_ledger;

-- ---------------------------------------------------------------- purchases
CREATE TABLE purchases_new (
  id                    INTEGER PRIMARY KEY,
  entry_no              TEXT NOT NULL UNIQUE,              -- internal number, e.g. PUR-0001
  series                TEXT NOT NULL DEFAULT 'purchase',  -- sequences.name
  seq_no                INTEGER NOT NULL,
  entry_date            TEXT NOT NULL,                     -- goods received (stock date)
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  supplier_name         TEXT NOT NULL,                     -- snapshots
  supplier_gstin        TEXT,
  supplier_state_code   TEXT,
  bill_no               TEXT,                              -- as printed on the supplier's bill
  bill_no_key           TEXT,                              -- upper-case, no spaces (duplicate check)
  bill_date             TEXT NOT NULL,                     -- supplier bill date (ledger, GST, due)
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  price_mode            TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')),
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  sub_total             INTEGER NOT NULL DEFAULT 0,        -- Σ qty × rate
  discount_total        INTEGER NOT NULL DEFAULT 0,        -- Σ line discounts
  taxable_total         INTEGER NOT NULL DEFAULT 0,        -- items only
  charges_taxable       INTEGER NOT NULL DEFAULT 0,        -- extra charges before GST
  charges_mode          TEXT NOT NULL DEFAULT 'cost' CHECK (charges_mode IN ('cost','expense')),
  cgst_total            INTEGER NOT NULL DEFAULT 0,        -- items + charges
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -500 AND 500),
  grand_total           INTEGER NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  printed_total         INTEGER,                           -- "bill total as printed" (optional)
  total_mismatch        INTEGER NOT NULL DEFAULT 0 CHECK (total_mismatch IN (0,1)),
  mismatch_amount       INTEGER NOT NULL DEFAULT 0,        -- printed_total - grand_total
  due_date              TEXT,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),  -- current line set
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  notes                 TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
INSERT INTO purchases_new (id, entry_no, seq_no, entry_date, party_id, supplier_name, supplier_gstin,
  supplier_state_code, bill_no, bill_no_key, bill_date, bill_type, price_mode, place_of_supply_code,
  is_interstate, sub_total, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
  tax_total, round_off, grand_total, status, cancel_reason, cancelled_at, notes, is_deleted,
  created_at, updated_at)
SELECT o.id, 'PUR-OLD-' || o.id, -o.id, o.bill_date, o.party_id, COALESCE(p.name, ''), o.supplier_gstin,
  o.supplier_state_code, o.bill_no, upper(replace(o.bill_no, ' ', '')), o.bill_date, o.bill_type,
  o.price_mode, COALESCE(o.supplier_state_code, ''), o.is_interstate, o.sub_total,
  o.item_discount_total + o.bill_discount, o.taxable_total, o.cgst_total, o.sgst_total, o.igst_total,
  o.tax_total, o.round_off, o.grand_total, o.status, o.cancel_reason, o.cancelled_at, o.notes,
  o.is_deleted, o.created_at, o.updated_at
FROM purchases o LEFT JOIN parties p ON p.id = o.party_id;
DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;
CREATE INDEX ix_purchases_bill_date ON purchases(bill_date);
CREATE INDEX ix_purchases_entry_date ON purchases(entry_date);
CREATE INDEX ix_purchases_party ON purchases(party_id, bill_date);
CREATE INDEX ix_purchases_due ON purchases(due_date) WHERE status = 'active';
-- Same supplier + same bill number may be entered once (cancelled bills do not count).
CREATE UNIQUE INDEX ux_purchases_supplier_bill ON purchases(party_id, bill_no_key)
  WHERE status = 'active' AND is_deleted = 0 AND bill_no_key IS NOT NULL;

-- ---------------------------------------------------------------- purchase items
-- Every revision of a purchase keeps its own lines; the current ones have
-- revision = purchases.revision. Older revisions stay for the audit trail.
CREATE TABLE purchase_items_new (
  id              INTEGER PRIMARY KEY,
  purchase_id     INTEGER NOT NULL REFERENCES purchases(id),
  revision        INTEGER NOT NULL DEFAULT 1,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  product_name    TEXT NOT NULL,                    -- snapshots
  variant_label   TEXT,
  sku             TEXT,
  unit            TEXT NOT NULL,
  hsn_code        TEXT,
  qty_milli       INTEGER NOT NULL CHECK (qty_milli > 0),         -- billed quantity
  free_qty_milli  INTEGER NOT NULL DEFAULT 0 CHECK (free_qty_milli >= 0),
  rate            INTEGER NOT NULL CHECK (rate >= 0),             -- per unit, as on the bill
  discount_bp     INTEGER CHECK (discount_bp IS NULL OR discount_bp BETWEEN 0 AND 10000),
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),  -- paise (from % or typed)
  gst_rate_bp     INTEGER NOT NULL DEFAULT 0,
  taxable         INTEGER NOT NULL,
  cgst            INTEGER NOT NULL DEFAULT 0,
  sgst            INTEGER NOT NULL DEFAULT 0,
  igst            INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  charges_share   INTEGER NOT NULL DEFAULT 0,       -- extra charges added to cost (landed cost)
  landed_total    INTEGER NOT NULL DEFAULT 0,       -- value added to stock
  unit_cost       INTEGER NOT NULL DEFAULT 0,       -- landed_total / (qty + free), per unit
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO purchase_items_new (id, purchase_id, product_id, variant_id, product_name, variant_label,
  unit, hsn_code, qty_milli, rate, discount, gst_rate_bp, taxable, cgst, sgst, igst, line_total,
  landed_total, sort_order, created_at, updated_at)
SELECT id, purchase_id, product_id, variant_id, product_name, variant_label, unit, hsn_code, qty_milli,
  rate, discount, gst_rate_bp, taxable, cgst, sgst, igst, line_total, taxable, sort_order,
  created_at, updated_at
FROM purchase_items;
DROP TABLE purchase_items;
ALTER TABLE purchase_items_new RENAME TO purchase_items;
CREATE INDEX ix_purchase_items_purchase ON purchase_items(purchase_id, revision);
CREATE INDEX ix_purchase_items_variant ON purchase_items(variant_id);
CREATE INDEX ix_purchase_items_product ON purchase_items(product_id);

-- ---------------------------------------------------------------- extra charges
CREATE TABLE purchase_charges (
  id           INTEGER PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  revision     INTEGER NOT NULL DEFAULT 1,
  kind         TEXT NOT NULL CHECK (kind IN ('freight','packing','other')),
  label        TEXT,
  amount       INTEGER NOT NULL CHECK (amount > 0),   -- as entered (follows the bill's price mode)
  gst_rate_bp  INTEGER NOT NULL DEFAULT 0,
  taxable      INTEGER NOT NULL,
  cgst         INTEGER NOT NULL DEFAULT 0,
  sgst         INTEGER NOT NULL DEFAULT 0,
  igst         INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_charges_purchase ON purchase_charges(purchase_id, revision);

-- ---------------------------------------------------------------- attachments (bill photo / PDF)
CREATE TABLE purchase_attachments (
  id             INTEGER PRIMARY KEY,
  purchase_id    INTEGER NOT NULL REFERENCES purchases(id),
  file_path      TEXT NOT NULL,       -- relative to data/: attachments/purchases/PUR-0001/ab12.pdf
  original_name  TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_attachments_purchase ON purchase_attachments(purchase_id);

-- ---------------------------------------------------------------- drafts (held bills)
-- The whole entry form as JSON ({ v: <draft schema version>, ... }). No stock or ledger effect.
CREATE TABLE purchase_drafts (
  id             INTEGER PRIMARY KEY,
  party_id       INTEGER REFERENCES parties(id),
  supplier_name  TEXT,
  bill_no        TEXT,
  item_count     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','saved','discarded')),
  purchase_id    INTEGER REFERENCES purchases(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_drafts_status ON purchase_drafts(status, updated_at);

-- ---------------------------------------------------------------- purchase returns (debit notes)
CREATE TABLE purchase_returns_new (
  id                    INTEGER PRIMARY KEY,
  return_no             TEXT NOT NULL UNIQUE,          -- DN-GST-0001 / DN-EST-0001
  series                TEXT NOT NULL,                 -- purchase_return_gst | purchase_return_non_gst
  seq_no                INTEGER NOT NULL,
  purchase_id           INTEGER REFERENCES purchases(id),   -- NULL = standalone
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  supplier_name         TEXT NOT NULL,
  supplier_gstin        TEXT,
  date                  TEXT NOT NULL,
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  taxable_total         INTEGER NOT NULL DEFAULT 0,
  cgst_total            INTEGER NOT NULL DEFAULT 0,
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),  -- credit agreed
  settlement            TEXT NOT NULL DEFAULT 'adjust' CHECK (settlement IN ('adjust','refund')),
  reason                TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
INSERT INTO purchase_returns_new (id, return_no, series, seq_no, purchase_id, party_id, supplier_name,
  date, bill_type, place_of_supply_code, is_interstate, taxable_total, cgst_total, sgst_total,
  igst_total, tax_total, round_off, total, reason, status, cancel_reason, cancelled_at, is_deleted,
  created_at, updated_at)
SELECT o.id, o.return_no, 'purchase_return_' || o.bill_type, -o.id, o.purchase_id, o.party_id,
  COALESCE(p.name, ''), o.date, o.bill_type, '', o.is_interstate, o.taxable_total, o.cgst_total,
  o.sgst_total, o.igst_total, o.tax_total, o.round_off, o.total, o.reason, o.status, o.cancel_reason,
  o.cancelled_at, o.is_deleted, o.created_at, o.updated_at
FROM purchase_returns o LEFT JOIN parties p ON p.id = o.party_id;
DROP TABLE purchase_returns;
ALTER TABLE purchase_returns_new RENAME TO purchase_returns;
CREATE INDEX ix_purchase_returns_date ON purchase_returns(date);
CREATE INDEX ix_purchase_returns_party ON purchase_returns(party_id);
CREATE INDEX ix_purchase_returns_purchase ON purchase_returns(purchase_id);

CREATE TABLE purchase_return_items_new (
  id                  INTEGER PRIMARY KEY,
  purchase_return_id  INTEGER NOT NULL REFERENCES purchase_returns(id),
  purchase_item_id    INTEGER REFERENCES purchase_items(id),
  product_id          INTEGER NOT NULL REFERENCES products(id),
  variant_id          INTEGER NOT NULL REFERENCES product_variants(id),
  product_name        TEXT NOT NULL,
  variant_label       TEXT,
  unit                TEXT NOT NULL,
  hsn_code            TEXT,
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  rate                INTEGER NOT NULL CHECK (rate >= 0),   -- effective taxable value per unit
  gst_rate_bp         INTEGER NOT NULL DEFAULT 0,
  default_taxable     INTEGER NOT NULL DEFAULT 0,           -- proportional value suggested
  taxable             INTEGER NOT NULL,                     -- credit agreed with the supplier
  cgst                INTEGER NOT NULL DEFAULT 0,
  sgst                INTEGER NOT NULL DEFAULT 0,
  igst                INTEGER NOT NULL DEFAULT 0,
  line_total          INTEGER NOT NULL,
  unit_cost           INTEGER NOT NULL DEFAULT 0,           -- original landed cost (stock value)
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO purchase_return_items_new (id, purchase_return_id, purchase_item_id, product_id, variant_id,
  product_name, unit, qty_milli, rate, gst_rate_bp, default_taxable, taxable, cgst, sgst, igst,
  line_total, unit_cost, created_at, updated_at)
SELECT r.id, r.purchase_return_id, r.purchase_item_id, r.product_id, r.variant_id, COALESCE(p.name, ''),
  COALESCE(p.unit, 'pcs'), r.qty_milli, r.rate, r.gst_rate_bp, r.taxable, r.taxable, r.cgst, r.sgst,
  r.igst, r.line_total, r.unit_cost, r.created_at, r.updated_at
FROM purchase_return_items r LEFT JOIN products p ON p.id = r.product_id;
DROP TABLE purchase_return_items;
ALTER TABLE purchase_return_items_new RENAME TO purchase_return_items;
CREATE INDEX ix_purchase_return_items_return ON purchase_return_items(purchase_return_id);
CREATE INDEX ix_purchase_return_items_item ON purchase_return_items(purchase_item_id);
CREATE INDEX ix_purchase_return_items_variant ON purchase_return_items(variant_id);

CREATE TABLE purchase_return_serials (
  id                       INTEGER PRIMARY KEY,
  purchase_return_item_id  INTEGER NOT NULL REFERENCES purchase_return_items(id),
  serial_id                INTEGER NOT NULL REFERENCES product_serials(id),
  from_status              TEXT NOT NULL,           -- in_stock | defective (restored on cancel)
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_return_serials_item ON purchase_return_serials(purchase_return_item_id);
CREATE INDEX ix_purchase_return_serials_serial ON purchase_return_serials(serial_id);

-- ---------------------------------------------------------------- serial numbers: 'voided'
-- 'voided' = removed from a purchase by an edit or a cancel (the unit never really existed
-- in the shop as entered). The key may then be entered again, so it is unique only among
-- rows that are not voided.
CREATE TABLE product_serials_new (
  id                     INTEGER PRIMARY KEY,
  product_id             INTEGER NOT NULL REFERENCES products(id),
  variant_id             INTEGER NOT NULL REFERENCES product_variants(id),
  serial_no              TEXT NOT NULL,
  serial_key             TEXT NOT NULL,
  serial_no_2            TEXT,
  serial_key_2           TEXT,
  is_auto                INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0,1)),
  status                 TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN
                           ('in_stock','sold','returned_to_supplier','under_claim','replaced',
                            'defective','written_off','voided')),
  source_type            TEXT NOT NULL CHECK (source_type IN ('opening','purchase','adjustment','replacement')),
  purchase_id            INTEGER REFERENCES purchases(id),
  purchase_item_id       INTEGER REFERENCES purchase_items(id),
  purchase_date          TEXT,
  supplier_party_id      INTEGER REFERENCES parties(id),
  supplier_warranty_end  TEXT,
  sale_id                INTEGER REFERENCES sales(id),
  sale_item_id           INTEGER REFERENCES sale_items(id),
  sale_date              TEXT,
  customer_party_id      INTEGER REFERENCES parties(id),
  warranty_start         TEXT,
  warranty_end           TEXT,
  warranty_overridden    INTEGER NOT NULL DEFAULT 0 CHECK (warranty_overridden IN (0,1)),
  replaces_serial_id     INTEGER REFERENCES product_serials(id),
  replaced_by_serial_id  INTEGER REFERENCES product_serials(id),
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO product_serials_new (id, product_id, variant_id, serial_no, serial_key, serial_no_2,
  serial_key_2, is_auto, status, source_type, purchase_id, purchase_date, supplier_party_id,
  supplier_warranty_end, sale_id, sale_item_id, sale_date, customer_party_id, warranty_start,
  warranty_end, warranty_overridden, replaces_serial_id, replaced_by_serial_id, notes, created_at,
  updated_at)
SELECT id, product_id, variant_id, serial_no, serial_key, serial_no_2, serial_key_2, is_auto, status,
  source_type, purchase_id, purchase_date, supplier_party_id, supplier_warranty_end, sale_id,
  sale_item_id, sale_date, customer_party_id, warranty_start, warranty_end, warranty_overridden,
  replaces_serial_id, replaced_by_serial_id, notes, created_at, updated_at
FROM product_serials;
DROP TABLE product_serials;
ALTER TABLE product_serials_new RENAME TO product_serials;
CREATE UNIQUE INDEX ux_product_serials_key ON product_serials(product_id, serial_key)
  WHERE status <> 'voided';
CREATE INDEX ix_product_serials_search ON product_serials(serial_key);
CREATE INDEX ix_product_serials_search2 ON product_serials(serial_key_2);
CREATE INDEX ix_product_serials_variant ON product_serials(variant_id, status);
CREATE INDEX ix_product_serials_sale ON product_serials(sale_id);
CREATE INDEX ix_product_serials_customer ON product_serials(customer_party_id);
CREATE INDEX ix_product_serials_warranty ON product_serials(warranty_end);
CREATE INDEX ix_product_serials_purchase ON product_serials(purchase_id);
CREATE INDEX ix_product_serials_purchase_item ON product_serials(purchase_item_id);

-- ---------------------------------------------------------------- bill-wise settlement
-- Which money settled which bill (paid / due per bill). The party ledger does not read this
-- table, so an allocation never changes a balance: it only says which bill a credit went to.
--   payment         a payment made against this bill
--   advance         credit the supplier already had (earlier advance / on-account payment)
--   purchase_return a debit note adjusted against this bill
CREATE TABLE bill_allocations (
  id            INTEGER PRIMARY KEY,
  party_id      INTEGER NOT NULL REFERENCES parties(id),
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('purchase','sale')),
  doc_id        INTEGER NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('payment','advance','purchase_return','sale_return')),
  source_id     INTEGER,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  date          TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_bill_allocations_doc ON bill_allocations(doc_type, doc_id);
CREATE INDEX ix_bill_allocations_source ON bill_allocations(source_type, source_id);
CREATE INDEX ix_bill_allocations_party ON bill_allocations(party_id);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE purchase_audit (
  id                  INTEGER PRIMARY KEY,
  purchase_id         INTEGER REFERENCES purchases(id),
  purchase_return_id  INTEGER REFERENCES purchase_returns(id),
  action              TEXT NOT NULL CHECK (action IN ('created','edited','cancelled','payment',
                        'refund','return','return_cancelled','attachment_added','attachment_removed')),
  actor               TEXT NOT NULL,        -- computer name until users / PIN (Phase 8)
  summary             TEXT NOT NULL,
  details             TEXT,                 -- JSON: what changed
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_audit_purchase ON purchase_audit(purchase_id, id);

-- ---------------------------------------------------------------- price change log
CREATE TABLE price_changes (
  id          INTEGER PRIMARY KEY,
  variant_id  INTEGER NOT NULL REFERENCES product_variants(id),
  field       TEXT NOT NULL CHECK (field IN ('purchase_price','mrp','selling_price')),
  old_value   INTEGER NOT NULL,
  new_value   INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('purchase','product')),
  ref_id      INTEGER,
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_price_changes_variant ON price_changes(variant_id, id);

-- ---------------------------------------------------------------- payments: mode + reference
ALTER TABLE payments ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('cash','upi','bank','cheque'));
ALTER TABLE payments ADD COLUMN ref_no TEXT;      -- cheque no. / UTR

-- ---------------------------------------------------------------- number series & settings
INSERT INTO sequences (name, prefix, pad_width) VALUES ('purchase', 'PUR-', 4);
UPDATE sequences SET name = 'purchase_return_gst',
  prefix = CASE prefix WHEN 'DN-' THEN 'DN-GST-' ELSE prefix END
  WHERE name = 'purchase_return';
INSERT INTO sequences (name, prefix, pad_width) VALUES ('purchase_return_non_gst', 'DN-EST-', 4);

INSERT INTO settings (key, value) VALUES
  ('purchase_price_mode', 'exclusive'),      -- inclusive | exclusive (supplier bills)
  ('purchase_charges_mode', 'cost');         -- cost | expense

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

-- Paid / due per active purchase. pay_status: paid | partial | unpaid | overdue.
CREATE VIEW v_purchase_dues AS
  SELECT t.*, t.grand_total - t.paid AS due,
    CASE
      WHEN t.grand_total - t.paid <= 0 THEN 'paid'
      WHEN t.due_date IS NOT NULL AND t.due_date < date('now','localtime') THEN 'overdue'
      WHEN t.paid > 0 THEN 'partial'
      ELSE 'unpaid'
    END AS pay_status
  FROM (
    SELECT pu.id AS purchase_id, pu.party_id, pu.grand_total, pu.due_date,
      COALESCE((SELECT SUM(a.amount) FROM bill_allocations a
        WHERE a.doc_type = 'purchase' AND a.doc_id = pu.id AND a.status = 'active'), 0) AS paid
    FROM purchases pu WHERE pu.status = 'active' AND pu.is_deleted = 0
  ) t;

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER trg_purchases_updated AFTER UPDATE ON purchases FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchases SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_items_updated AFTER UPDATE ON purchase_items FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_items SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_charges_updated AFTER UPDATE ON purchase_charges FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_charges SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_attachments_updated AFTER UPDATE ON purchase_attachments FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_attachments SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_drafts_updated AFTER UPDATE ON purchase_drafts FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_drafts SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_returns_updated AFTER UPDATE ON purchase_returns FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_returns SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_bill_allocations_updated AFTER UPDATE ON bill_allocations FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE bill_allocations SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_product_serials_updated AFTER UPDATE ON product_serials FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE product_serials SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER trg_product_serials_no_delete BEFORE DELETE ON product_serials
  BEGIN SELECT RAISE(ABORT, 'serial numbers are never deleted'); END;
CREATE TRIGGER trg_purchases_no_delete BEFORE DELETE ON purchases
  BEGIN SELECT RAISE(ABORT, 'purchases are never deleted'); END;
CREATE TRIGGER trg_purchase_items_no_delete BEFORE DELETE ON purchase_items
  BEGIN SELECT RAISE(ABORT, 'purchase lines are never deleted'); END;
CREATE TRIGGER trg_purchase_returns_no_delete BEFORE DELETE ON purchase_returns
  BEGIN SELECT RAISE(ABORT, 'purchase returns are never deleted'); END;
CREATE TRIGGER trg_bill_allocations_no_delete BEFORE DELETE ON bill_allocations
  BEGIN SELECT RAISE(ABORT, 'bill allocations are never deleted'); END;
CREATE TRIGGER trg_purchase_audit_no_update BEFORE UPDATE ON purchase_audit
  BEGIN SELECT RAISE(ABORT, 'purchase_audit is append-only'); END;
CREATE TRIGGER trg_purchase_audit_no_delete BEFORE DELETE ON purchase_audit
  BEGIN SELECT RAISE(ABORT, 'purchase_audit is append-only'); END;
CREATE TRIGGER trg_price_changes_no_update BEFORE UPDATE ON price_changes
  BEGIN SELECT RAISE(ABORT, 'price_changes is append-only'); END;
CREATE TRIGGER trg_price_changes_no_delete BEFORE DELETE ON price_changes
  BEGIN SELECT RAISE(ABORT, 'price_changes is append-only'); END;

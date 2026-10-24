-- foreign_keys: off
-- 007_warranty: warranty claims (Phase 5.5), defective stock location, warranty money.
-- Rebuilds stock_movements (new 'location' column + movement types) and warranty_claims (the
-- 003 placeholder, never written by the app) with SQLite's 12-step procedure.
-- migrate.js runs this file with foreign_keys OFF inside one transaction, then runs
-- foreign_key_check + integrity_check before COMMIT. A backup is taken just before.

-- Views read the tables being rebuilt; they are recreated at the end.
DROP VIEW v_variant_stock;
DROP VIEW v_party_balance;
DROP VIEW v_party_ledger;

-- ---------------------------------------------------------------- stock movements: location
-- location 'main' = sellable stock (what every stock figure means), 'defective' = units kept
-- out of sale (returned faulty, taken back on a warranty claim). Sellable stock is
-- SUM(qty_milli) WHERE location = 'main'. For serial-tracked variants:
--   SUM(main) = 1000 × in_stock units,  SUM(defective) = 1000 × defective units.
CREATE TABLE stock_movements_new (
  id          INTEGER PRIMARY KEY,
  variant_id  INTEGER NOT NULL REFERENCES product_variants(id),
  date        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN
                ('opening','purchase','purchase_return','sale','sale_return','adjustment',
                 'warranty_return_in','warranty_replacement_out','warranty_parts_used',
                 'supplier_claim_out','supplier_claim_in','write_off')),
  location    TEXT NOT NULL DEFAULT 'main' CHECK (location IN ('main','defective')),
  qty_milli   INTEGER NOT NULL CHECK (qty_milli <> 0),  -- + in, - out
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  ref_type    TEXT,
  ref_id      INTEGER,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
INSERT INTO stock_movements_new (id, variant_id, date, type, qty_milli, unit_cost, ref_type, ref_id,
  reason, created_at, updated_at)
SELECT id, variant_id, date, type, qty_milli, unit_cost, ref_type, ref_id, reason, created_at,
  updated_at
FROM stock_movements;
DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;
CREATE INDEX ix_stock_movements_variant_date ON stock_movements(variant_id, location, date, id);
CREATE INDEX ix_stock_movements_ref ON stock_movements(ref_type, ref_id);

-- Units already marked defective had left stock with no record of where they went: give
-- each its defective-location row, at the variant's average cost.
INSERT INTO stock_movements (variant_id, date, type, location, qty_milli, unit_cost, ref_type, ref_id, reason)
SELECT s.variant_id, date('now','localtime'), 'adjustment', 'defective', 1000, v.avg_cost, 'serial', s.id,
  s.serial_no || ': defective unit carried over (007)'
FROM product_serials s JOIN product_variants v ON v.id = s.variant_id
WHERE s.status = 'defective';

-- ---------------------------------------------------------------- warranty claims
-- kind 'customer' = a sold unit / bill line brought back by a customer.
-- kind 'stock'    = our own defective unit sent to the supplier (from the Defective list).
-- customer_party_id is the ORIGINAL buyer (warranty follows the unit); brought_by_* is who
-- brought it in when that is someone else.
CREATE TABLE warranty_claims_new (
  id                        INTEGER PRIMARY KEY,
  claim_no                  TEXT NOT NULL UNIQUE,             -- WC-0001
  series                    TEXT NOT NULL DEFAULT 'warranty_claim',
  seq_no                    INTEGER NOT NULL,
  kind                      TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','stock')),
  serial_id                 INTEGER REFERENCES product_serials(id),
  sale_id                   INTEGER REFERENCES sales(id),
  sale_item_id              INTEGER REFERENCES sale_items(id),
  product_id                INTEGER NOT NULL REFERENCES products(id),
  variant_id                INTEGER NOT NULL REFERENCES product_variants(id),
  qty_milli                 INTEGER NOT NULL DEFAULT 1000 CHECK (qty_milli > 0),
  customer_party_id         INTEGER REFERENCES parties(id),
  customer_name             TEXT,                             -- snapshots (slip reprints)
  customer_phone            TEXT,
  vehicle_id                INTEGER REFERENCES vehicles(id),
  vehicle_no                TEXT,
  vehicle_model             TEXT,
  brought_by_name           TEXT,
  brought_by_phone          TEXT,
  ownership_note            TEXT,
  supplier_party_id         INTEGER REFERENCES parties(id),
  in_warranty               INTEGER NOT NULL DEFAULT 1 CHECK (in_warranty IN (0,1)),
  chargeable                INTEGER NOT NULL DEFAULT 0 CHECK (chargeable IN (0,1)),
  warranty_end              TEXT,                             -- customer warranty at receipt
  received_date             TEXT NOT NULL,
  received_by               TEXT,
  complaint                 TEXT NOT NULL,
  complaint_tags            TEXT,                             -- JSON array of quick picks
  condition_notes           TEXT,
  accessories               TEXT,                             -- JSON array (box, remote, wires…)
  expected_date             TEXT,
  status                    TEXT NOT NULL DEFAULT 'received' CHECK (status IN
                              ('received','inspecting','repairing','at_supplier',
                               'awaiting_replacement','ready','returned','closed','rejected',
                               'cancelled')),
  decision                  TEXT CHECK (decision IS NULL OR decision IN
                              ('repair','supplier','replace','refund','reject')),
  inspection_notes          TEXT,
  inspected_date            TEXT,
  reject_reason             TEXT CHECK (reject_reason IS NULL OR reject_reason IN
                              ('physical_damage','water_damage','tampered','wrong_fitting','other')),
  reject_notes              TEXT,
  repair_notes              TEXT,
  labour_amount             INTEGER NOT NULL DEFAULT 0 CHECK (labour_amount >= 0),
  replacement_serial_id     INTEGER REFERENCES product_serials(id),
  replacement_mode          TEXT CHECK (replacement_mode IS NULL OR replacement_mode IN ('remaining','fresh')),
  replacement_reason        TEXT,
  replacement_warranty_end  TEXT,
  sale_return_id            INTEGER REFERENCES sale_returns(id),   -- refund / credit note
  bill_sale_id              INTEGER REFERENCES sales(id),          -- chargeable repair bill
  outcome                   TEXT CHECK (outcome IS NULL OR outcome IN
                              ('repaired','replaced','refunded','rejected','returned_as_is',
                               'supplier_repaired','supplier_replaced','supplier_credit',
                               'absorbed')),
  handover_date             TEXT,
  handed_over_by            TEXT,
  final_notes               TEXT,
  closed_date               TEXT,
  cancel_reason             TEXT,
  cancelled_at              TEXT,
  notes                     TEXT,
  is_deleted                INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no),
  CHECK (kind = 'stock' OR serial_id IS NOT NULL OR sale_item_id IS NOT NULL)
);
INSERT INTO warranty_claims_new (id, claim_no, seq_no, serial_id, sale_id, sale_item_id, product_id,
  variant_id, customer_party_id, supplier_party_id, received_date, complaint, status, notes,
  is_deleted, created_at, updated_at)
SELECT c.id, c.claim_no, -c.id, c.serial_id, c.sale_id, c.sale_item_id, v.product_id, c.variant_id,
  c.customer_party_id, c.supplier_party_id, c.received_date, c.issue,
  CASE c.status WHEN 'sent_to_supplier' THEN 'at_supplier' WHEN 'repaired' THEN 'ready'
    WHEN 'replaced' THEN 'ready' WHEN 'returned_to_customer' THEN 'returned' ELSE c.status END,
  c.notes, c.is_deleted, c.created_at, c.updated_at
FROM warranty_claims c JOIN product_variants v ON v.id = c.variant_id;
DROP TABLE warranty_claims;
ALTER TABLE warranty_claims_new RENAME TO warranty_claims;
CREATE INDEX ix_warranty_claims_status ON warranty_claims(status, received_date);
CREATE INDEX ix_warranty_claims_serial ON warranty_claims(serial_id);
CREATE INDEX ix_warranty_claims_sale ON warranty_claims(sale_id);
CREATE INDEX ix_warranty_claims_item ON warranty_claims(sale_item_id);
CREATE INDEX ix_warranty_claims_customer ON warranty_claims(customer_party_id);
CREATE INDEX ix_warranty_claims_supplier ON warranty_claims(supplier_party_id);
CREATE INDEX ix_warranty_claims_product ON warranty_claims(product_id);
-- A unit can have only ONE open claim at a time (per kind: the faulty unit a customer claim
-- took back may go to the supplier on a 'stock' claim while the customer claim is still open).
CREATE UNIQUE INDEX ux_warranty_claims_open_serial ON warranty_claims(serial_id, kind)
  WHERE serial_id IS NOT NULL AND is_deleted = 0 AND status NOT IN ('closed','cancelled');

-- Every status change and action, with date + note (append-only).
CREATE TABLE claim_events (
  id           INTEGER PRIMARY KEY,
  claim_id     INTEGER NOT NULL REFERENCES warranty_claims(id),
  date         TEXT NOT NULL,
  type         TEXT NOT NULL,           -- received | inspected | decided | dispatched | supplier_result | ...
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  actor        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_claim_events_claim ON claim_events(claim_id, id);

-- Units sent to a supplier for a claim. 'at_supplier' rows are the open ones.
CREATE TABLE claim_dispatches (
  id                 INTEGER PRIMARY KEY,
  claim_id           INTEGER NOT NULL REFERENCES warranty_claims(id),
  supplier_party_id  INTEGER NOT NULL REFERENCES parties(id),
  dispatch_date      TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('hand','courier')),
  courier            TEXT,
  docket_no          TEXT,
  expected_date      TEXT,
  qty_milli          INTEGER NOT NULL DEFAULT 1000 CHECK (qty_milli > 0),
  sent_value         INTEGER NOT NULL DEFAULT 0 CHECK (sent_value >= 0),  -- our defective stock sent (cost)
  status             TEXT NOT NULL DEFAULT 'at_supplier' CHECK (status IN ('at_supplier','back','cancelled')),
  result             TEXT CHECK (result IS NULL OR result IN ('repaired','replaced','credit','rejected')),
  result_date        TEXT,
  result_notes       TEXT,
  new_serial_id      INTEGER REFERENCES product_serials(id),
  new_to             TEXT CHECK (new_to IS NULL OR new_to IN ('customer','stock')),
  credit_amount      INTEGER CHECK (credit_amount IS NULL OR credit_amount >= 0),
  credit_ref         TEXT,
  rejected_action    TEXT CHECK (rejected_action IS NULL OR rejected_action IN
                       ('return_as_is','chargeable','absorb')),
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_claim_dispatches_claim ON claim_dispatches(claim_id, id);
CREATE INDEX ix_claim_dispatches_open ON claim_dispatches(status, expected_date);
CREATE INDEX ix_claim_dispatches_supplier ON claim_dispatches(supplier_party_id);

-- Parts used in a shop repair (stock out, movement warranty_parts_used, unless the repair is
-- chargeable: then the parts go out through the bill).
CREATE TABLE claim_parts (
  id            INTEGER PRIMARY KEY,
  claim_id      INTEGER NOT NULL REFERENCES warranty_claims(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id),
  product_name  TEXT NOT NULL,
  variant_label TEXT,
  unit          TEXT NOT NULL,
  qty_milli     INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  chargeable    INTEGER NOT NULL DEFAULT 0 CHECK (chargeable IN (0,1)),
  movement_id   INTEGER REFERENCES stock_movements(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_claim_parts_claim ON claim_parts(claim_id);

-- Photos of the unit: relative to data/, e.g. attachments/claims/WC-0001/ab12.jpg
CREATE TABLE claim_attachments (
  id             INTEGER PRIMARY KEY,
  claim_id       INTEGER NOT NULL REFERENCES warranty_claims(id),
  file_path      TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_claim_attachments_claim ON claim_attachments(claim_id);

-- Warranty money (append-only; a reversal is status 'cancelled' on the row).
--   cost:      replacement (unit given from stock), parts, labour, write_off
--   recovery:  supplier_replacement (good unit received), supplier_credit (credit note:
--              also reduces the supplier payable through v_party_ledger), repaired_to_stock
-- Net warranty loss = Σ cost − Σ recovery. Amounts at weighted average cost.
CREATE TABLE warranty_costs (
  id          INTEGER PRIMARY KEY,
  claim_id    INTEGER REFERENCES warranty_claims(id),      -- NULL: defective stock write-off
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('replacement','parts','labour','write_off',
                'supplier_replacement','supplier_credit','repaired_to_stock')),
  direction   TEXT NOT NULL CHECK (direction IN ('cost','recovery')),
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  variant_id  INTEGER REFERENCES product_variants(id),
  serial_id   INTEGER REFERENCES product_serials(id),
  qty_milli   INTEGER,
  party_id    INTEGER REFERENCES parties(id),              -- supplier (recoveries)
  ref_no      TEXT,                                        -- supplier's credit note no.
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_warranty_costs_claim ON warranty_costs(claim_id);
CREATE INDEX ix_warranty_costs_date ON warranty_costs(date, kind);
CREATE INDEX ix_warranty_costs_party ON warranty_costs(party_id) WHERE party_id IS NOT NULL;

-- ---------------------------------------------------------------- warranty terms / void
ALTER TABLE products ADD COLUMN warranty_covered TEXT;      -- printed on claim slips / cards
ALTER TABLE products ADD COLUMN warranty_not_covered TEXT;

-- Warranty voided by hand (physical damage, water damage, tampered, wrong fitting, other).
ALTER TABLE product_serials ADD COLUMN warranty_void_reason TEXT;
ALTER TABLE product_serials ADD COLUMN warranty_void_note TEXT;
ALTER TABLE product_serials ADD COLUMN warranty_voided_at TEXT;
ALTER TABLE sale_items ADD COLUMN warranty_void_reason TEXT;
ALTER TABLE sale_items ADD COLUMN warranty_void_note TEXT;
ALTER TABLE sale_items ADD COLUMN warranty_voided_at TEXT;

-- A unit given as a warranty replacement is linked to the original bill line, so the bill
-- shows it and searches by its serial find the bill.
ALTER TABLE sale_item_serials ADD COLUMN is_replacement INTEGER NOT NULL DEFAULT 0
  CHECK (is_replacement IN (0,1));
ALTER TABLE sale_item_serials ADD COLUMN claim_id INTEGER REFERENCES warranty_claims(id);

-- ---------------------------------------------------------------- settings
INSERT INTO settings (key, value) VALUES
  ('warranty_expiring_days', '30'),
  ('replacement_warranty', 'remaining'),   -- remaining | fresh (warranty of a replacement unit)
  ('claim_slip_format', 'a4half'),         -- a4half (A4: customer copy + shop copy) | thermal80
  ('claim_terms', 'Please bring this slip when collecting the item.
The shop is not responsible for items not collected within 60 days.
Warranty does not cover physical damage, water damage, tampering or wrong fitting.'),
  ('claim_issue_presets', '');             -- JSON { "<category id>": ["No sound", …] } or '' (defaults)

-- ---------------------------------------------------------------- views
CREATE VIEW v_variant_stock AS
  SELECT v.id AS variant_id, v.product_id,
    COALESCE(SUM(CASE WHEN m.location = 'main' THEN m.qty_milli END), 0) AS stock_milli,
    COALESCE(SUM(CASE WHEN m.location = 'defective' THEN m.qty_milli END), 0) AS defective_milli
  FROM product_variants v LEFT JOIN stock_movements m ON m.variant_id = v.id
  GROUP BY v.id;

-- Sign: + = party owes us (receivable), - = we owe the party (payable / advance).
-- A supplier's warranty credit note reduces what we owe them (+).
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
  FROM purchase_returns pr WHERE pr.status = 'active' AND pr.is_deleted = 0
  UNION ALL
  SELECT wc.party_id, wc.date, 'warranty_credit', wc.claim_id,
    c.claim_no || CASE WHEN wc.ref_no IS NOT NULL AND wc.ref_no <> '' THEN ' / ' || wc.ref_no ELSE '' END,
    wc.amount, '1' || wc.created_at
  FROM warranty_costs wc JOIN warranty_claims c ON c.id = wc.claim_id
  WHERE wc.kind = 'supplier_credit' AND wc.status = 'active' AND wc.party_id IS NOT NULL
    AND wc.amount > 0;

CREATE VIEW v_party_balance AS
  SELECT party_id, SUM(amount) AS balance FROM v_party_ledger GROUP BY party_id;

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
  BEGIN SELECT RAISE(ABORT, 'stock_movements are append-only'); END;
CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
  BEGIN SELECT RAISE(ABORT, 'stock_movements are append-only'); END;

CREATE TRIGGER trg_warranty_claims_updated AFTER UPDATE ON warranty_claims FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE warranty_claims SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_claim_dispatches_updated AFTER UPDATE ON claim_dispatches FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE claim_dispatches SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_claim_attachments_updated AFTER UPDATE ON claim_attachments FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE claim_attachments SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_warranty_costs_updated AFTER UPDATE ON warranty_costs FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE warranty_costs SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER trg_warranty_claims_no_delete BEFORE DELETE ON warranty_claims
  BEGIN SELECT RAISE(ABORT, 'warranty claims are never deleted'); END;
CREATE TRIGGER trg_claim_dispatches_no_delete BEFORE DELETE ON claim_dispatches
  BEGIN SELECT RAISE(ABORT, 'claim dispatches are never deleted'); END;
CREATE TRIGGER trg_claim_parts_no_delete BEFORE DELETE ON claim_parts
  BEGIN SELECT RAISE(ABORT, 'claim parts are never deleted'); END;
CREATE TRIGGER trg_claim_parts_no_update BEFORE UPDATE ON claim_parts
  BEGIN SELECT RAISE(ABORT, 'claim parts are append-only'); END;
CREATE TRIGGER trg_claim_events_no_update BEFORE UPDATE ON claim_events
  BEGIN SELECT RAISE(ABORT, 'claim_events are append-only'); END;
CREATE TRIGGER trg_claim_events_no_delete BEFORE DELETE ON claim_events
  BEGIN SELECT RAISE(ABORT, 'claim_events are append-only'); END;
CREATE TRIGGER trg_warranty_costs_no_delete BEFORE DELETE ON warranty_costs
  BEGIN SELECT RAISE(ABORT, 'warranty costs are never deleted'); END;

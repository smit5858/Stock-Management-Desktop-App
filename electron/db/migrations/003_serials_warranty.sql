-- 003_serials_warranty: per-unit serial numbers, warranty settings, warranty claims,
-- vehicle number on sales and warranty on bill lines.

-- ---------------------------------------------------------------- product warranty settings
ALTER TABLE products RENAME COLUMN warranty_months TO customer_warranty_months;
ALTER TABLE products ADD COLUMN supplier_warranty_months INTEGER NOT NULL DEFAULT 0
  CHECK (supplier_warranty_months BETWEEN 0 AND 240);
ALTER TABLE products ADD COLUMN warranty_start_basis TEXT NOT NULL DEFAULT 'sale'
  CHECK (warranty_start_basis IN ('sale','purchase'));
ALTER TABLE products ADD COLUMN track_serials INTEGER NOT NULL DEFAULT 0
  CHECK (track_serials IN (0,1));

-- ---------------------------------------------------------------- serial numbers
-- One row per physical unit. Never deleted: units leave stock by status, with history in
-- serial_events. Every change into or out of 'in_stock' writes a stock_movement in the same
-- transaction, so SUM(stock_movements) = number of in_stock serials for tracked variants.
CREATE TABLE product_serials (
  id                     INTEGER PRIMARY KEY,
  product_id             INTEGER NOT NULL REFERENCES products(id),
  variant_id             INTEGER NOT NULL REFERENCES product_variants(id),
  serial_no              TEXT NOT NULL,            -- as entered (trimmed)
  serial_key             TEXT NOT NULL,            -- upper-case, no spaces: used for matching
  serial_no_2            TEXT,                     -- optional second number (sets / box)
  serial_key_2           TEXT,
  is_auto                INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0,1)),  -- generated, not printed
  status                 TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN
                           ('in_stock','sold','returned_to_supplier','under_claim','replaced',
                            'defective','written_off')),
  source_type            TEXT NOT NULL CHECK (source_type IN ('opening','purchase','adjustment','replacement')),
  purchase_id            INTEGER REFERENCES purchases(id),
  purchase_date          TEXT,                     -- also set for opening stock / adjustments
  supplier_party_id      INTEGER REFERENCES parties(id),
  supplier_warranty_end  TEXT,
  sale_id                INTEGER REFERENCES sales(id),
  sale_item_id           INTEGER REFERENCES sale_items(id),
  sale_date              TEXT,
  customer_party_id      INTEGER REFERENCES parties(id),
  warranty_start         TEXT,
  warranty_end           TEXT,                     -- inclusive
  warranty_overridden    INTEGER NOT NULL DEFAULT 0 CHECK (warranty_overridden IN (0,1)),
  replaces_serial_id     INTEGER REFERENCES product_serials(id),
  replaced_by_serial_id  INTEGER REFERENCES product_serials(id),
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_product_serials_key ON product_serials(product_id, serial_key);
CREATE INDEX ix_product_serials_search ON product_serials(serial_key);
CREATE INDEX ix_product_serials_search2 ON product_serials(serial_key_2);
CREATE INDEX ix_product_serials_variant ON product_serials(variant_id, status);
CREATE INDEX ix_product_serials_sale ON product_serials(sale_id);
CREATE INDEX ix_product_serials_customer ON product_serials(customer_party_id);
CREATE INDEX ix_product_serials_warranty ON product_serials(warranty_end);

-- Full history of every unit (append-only).
CREATE TABLE serial_events (
  id           INTEGER PRIMARY KEY,
  serial_id    INTEGER NOT NULL REFERENCES product_serials(id),
  date         TEXT NOT NULL,
  type         TEXT NOT NULL,   -- received_opening | adjusted_in | marked_defective | written_off | ...
  from_status  TEXT,
  to_status    TEXT,
  ref_type     TEXT,            -- 'sale' | 'purchase' | 'warranty_claim' | 'stock_movement' ...
  ref_id       INTEGER,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_serial_events_serial ON serial_events(serial_id, id);

-- ---------------------------------------------------------------- warranty claims (Phase 5.5)
-- For a serial unit (serial_id) or a non-serial bill line (sale_item_id).
CREATE TABLE warranty_claims (
  id                     INTEGER PRIMARY KEY,
  claim_no               TEXT NOT NULL UNIQUE,
  serial_id              INTEGER REFERENCES product_serials(id),
  sale_id                INTEGER REFERENCES sales(id),
  sale_item_id           INTEGER REFERENCES sale_items(id),
  variant_id             INTEGER NOT NULL REFERENCES product_variants(id),
  customer_party_id      INTEGER REFERENCES parties(id),
  supplier_party_id      INTEGER REFERENCES parties(id),
  received_date          TEXT NOT NULL,
  issue                  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'received' CHECK (status IN
                           ('received','sent_to_supplier','repaired','replaced','rejected','returned_to_customer')),
  sent_date              TEXT,
  resolved_date          TEXT,
  returned_date          TEXT,
  resolution_note        TEXT,
  replacement_serial_id  INTEGER REFERENCES product_serials(id),
  fresh_warranty         INTEGER NOT NULL DEFAULT 0 CHECK (fresh_warranty IN (0,1)),
  notes                  TEXT,
  is_deleted             INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  CHECK (serial_id IS NOT NULL OR sale_item_id IS NOT NULL)
);
CREATE INDEX ix_warranty_claims_status ON warranty_claims(status);
CREATE INDEX ix_warranty_claims_serial ON warranty_claims(serial_id);
CREATE INDEX ix_warranty_claims_customer ON warranty_claims(customer_party_id);

-- ---------------------------------------------------------------- sales: vehicle + line warranty
ALTER TABLE sales ADD COLUMN vehicle_no TEXT;            -- as typed: GJ-03-AB-1234
ALTER TABLE sales ADD COLUMN vehicle_no_key TEXT;        -- GJ03AB1234 (search)
ALTER TABLE sales ADD COLUMN vehicle_model TEXT;
CREATE INDEX ix_sales_vehicle ON sales(vehicle_no_key);

ALTER TABLE sale_items ADD COLUMN warranty_months INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN warranty_end TEXT;     -- inclusive; NULL = no warranty
CREATE INDEX ix_sale_items_warranty ON sale_items(warranty_end);

-- ---------------------------------------------------------------- sequences
-- Auto-generated serials are numbered per prefix (OLD-0001, OLD-0002 …) from existing rows,
-- so they need no sequence.
INSERT INTO sequences (name, prefix, pad_width) VALUES ('warranty_claim', 'WC-', 4);

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER trg_product_serials_updated AFTER UPDATE ON product_serials FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE product_serials SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_warranty_claims_updated AFTER UPDATE ON warranty_claims FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE warranty_claims SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_product_serials_no_delete BEFORE DELETE ON product_serials
  BEGIN SELECT RAISE(ABORT, 'serial numbers are never deleted'); END;
CREATE TRIGGER trg_serial_events_no_update BEFORE UPDATE ON serial_events
  BEGIN SELECT RAISE(ABORT, 'serial_events are append-only'); END;
CREATE TRIGGER trg_serial_events_no_delete BEFORE DELETE ON serial_events
  BEGIN SELECT RAISE(ABORT, 'serial_events are append-only'); END;

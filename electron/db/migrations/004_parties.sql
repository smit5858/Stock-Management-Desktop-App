-- 004_parties: customers & suppliers (Phase 3).
-- Customers and suppliers are separate rows of `parties` (type 'customer' | 'supplier').
-- A firm that is both gets two rows joined by linked_party_id; their ledgers never mix.
-- phone / alt_phone are stored normalised (10 digits); plates normalised (GJ03AB1234).
-- Balances are never stored: they come from v_party_ledger / v_party_balance.

-- ---------------------------------------------------------------- customer types
CREATE TABLE customer_types (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  default_discount_bp  INTEGER NOT NULL DEFAULT 0 CHECK (default_discount_bp BETWEEN 0 AND 10000),
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_deleted           INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_customer_types_name ON customer_types(name COLLATE NOCASE) WHERE is_deleted = 0;

INSERT INTO customer_types (name, sort_order) VALUES
  ('Retail', 1), ('Garage/Mechanic', 2), ('Dealer', 3), ('Fleet', 4);

-- ---------------------------------------------------------------- parties: new fields
ALTER TABLE parties ADD COLUMN alt_phone TEXT;
ALTER TABLE parties ADD COLUMN whatsapp_same INTEGER NOT NULL DEFAULT 1 CHECK (whatsapp_same IN (0,1));
ALTER TABLE parties ADD COLUMN email TEXT;
ALTER TABLE parties ADD COLUMN firm_name TEXT;            -- business customers
ALTER TABLE parties ADD COLUMN contact_person TEXT;       -- suppliers (name = firm name)
ALTER TABLE parties ADD COLUMN city TEXT;
ALTER TABLE parties ADD COLUMN pincode TEXT;
ALTER TABLE parties ADD COLUMN customer_type_id INTEGER REFERENCES customer_types(id);
ALTER TABLE parties ADD COLUMN credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0);
ALTER TABLE parties ADD COLUMN opening_balance_date TEXT;
ALTER TABLE parties ADD COLUMN payment_terms_days INTEGER
  CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);
ALTER TABLE parties ADD COLUMN supplies TEXT;             -- brands / categories supplied
ALTER TABLE parties ADD COLUMN bank_details TEXT;         -- bank / UPI, for reference only
ALTER TABLE parties ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1));
ALTER TABLE parties ADD COLUMN linked_party_id INTEGER REFERENCES parties(id);
ALTER TABLE parties ADD COLUMN merged_into_id INTEGER REFERENCES parties(id);

-- Identity: a phone number belongs to one customer (and, separately, one supplier).
CREATE UNIQUE INDEX ux_parties_customer_phone ON parties(phone)
  WHERE type = 'customer' AND is_deleted = 0 AND phone IS NOT NULL;
CREATE UNIQUE INDEX ux_parties_supplier_phone ON parties(phone)
  WHERE type = 'supplier' AND is_deleted = 0 AND phone IS NOT NULL;
CREATE UNIQUE INDEX ux_parties_gstin ON parties(type, gstin)
  WHERE is_deleted = 0 AND gstin IS NOT NULL;
CREATE INDEX ix_parties_alt_phone ON parties(alt_phone);
CREATE INDEX ix_parties_type ON parties(type, is_deleted, is_active);

-- ---------------------------------------------------------------- customer vehicles
CREATE TABLE vehicles (
  id                INTEGER PRIMARY KEY,
  plate_no          TEXT NOT NULL,            -- normalised: GJ03AB1234 / 22BH1234AA
  customer_id       INTEGER NOT NULL REFERENCES parties(id),  -- current owner
  vehicle_model_id  INTEGER REFERENCES vehicle_models(id),    -- same master as product compatibility
  variant           TEXT,
  year              INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2200),
  fuel              TEXT CHECK (fuel IS NULL OR fuel IN ('petrol','diesel','cng','ev','hybrid')),
  color             TEXT,
  notes             TEXT,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  is_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_vehicles_plate ON vehicles(plate_no) WHERE is_deleted = 0;
CREATE UNIQUE INDEX ux_vehicles_primary ON vehicles(customer_id) WHERE is_primary = 1 AND is_deleted = 0;
CREATE INDEX ix_vehicles_customer ON vehicles(customer_id);
CREATE INDEX ix_vehicles_model ON vehicles(vehicle_model_id);

-- Ownership history. The open row (to_date NULL) is the current owner. Never deleted.
CREATE TABLE vehicle_owners (
  id           INTEGER PRIMARY KEY,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id),
  customer_id  INTEGER NOT NULL REFERENCES parties(id),
  from_date    TEXT NOT NULL,
  to_date      TEXT,                          -- inclusive last day; NULL = current owner
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_vehicle_owners_vehicle ON vehicle_owners(vehicle_id, from_date);
CREATE INDEX ix_vehicle_owners_customer ON vehicle_owners(customer_id);
CREATE UNIQUE INDEX ux_vehicle_owners_current ON vehicle_owners(vehicle_id) WHERE to_date IS NULL;

-- Bills remember the vehicle (Phase 5). vehicle_no / vehicle_no_key (003) stay as snapshots.
ALTER TABLE sales ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id);
CREATE INDEX ix_sales_vehicle_id ON sales(vehicle_id);

-- ---------------------------------------------------------------- merge log (append-only)
CREATE TABLE party_merges (
  id          INTEGER PRIMARY KEY,
  kept_id     INTEGER NOT NULL REFERENCES parties(id),
  merged_id   INTEGER NOT NULL REFERENCES parties(id),
  date        TEXT NOT NULL,
  details     TEXT NOT NULL,                  -- JSON: rows moved per table, old opening balances
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);

-- ---------------------------------------------------------------- ledger views
-- Sign: + = party owes us (receivable), - = we owe the party (payable / advance).
-- sort_key orders entries of the same date: opening first, then documents by creation.
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
  SELECT pu.party_id, pu.bill_date, 'purchase', pu.id, pu.bill_no, -pu.grand_total, '1' || pu.created_at
  FROM purchases pu WHERE pu.status = 'active' AND pu.is_deleted = 0
  UNION ALL
  SELECT pr.party_id, pr.date, 'purchase_return', pr.id, pr.return_no, pr.total, '1' || pr.created_at
  FROM purchase_returns pr WHERE pr.status = 'active' AND pr.is_deleted = 0;

CREATE VIEW v_party_balance AS
  SELECT party_id, SUM(amount) AS balance FROM v_party_ledger GROUP BY party_id;

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER trg_customer_types_updated AFTER UPDATE ON customer_types FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE customer_types SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_vehicles_updated AFTER UPDATE ON vehicles FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE vehicles SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_vehicle_owners_updated AFTER UPDATE ON vehicle_owners FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE vehicle_owners SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_vehicles_no_delete BEFORE DELETE ON vehicles
  BEGIN SELECT RAISE(ABORT, 'vehicles are never deleted'); END;
CREATE TRIGGER trg_vehicle_owners_no_delete BEFORE DELETE ON vehicle_owners
  BEGIN SELECT RAISE(ABORT, 'vehicle ownership history is never deleted'); END;
CREATE TRIGGER trg_parties_no_delete BEFORE DELETE ON parties
  BEGIN SELECT RAISE(ABORT, 'parties are never deleted'); END;
CREATE TRIGGER trg_party_merges_no_update BEFORE UPDATE ON party_merges
  BEGIN SELECT RAISE(ABORT, 'party_merges is append-only'); END;
CREATE TRIGGER trg_party_merges_no_delete BEFORE DELETE ON party_merges
  BEGIN SELECT RAISE(ABORT, 'party_merges is append-only'); END;

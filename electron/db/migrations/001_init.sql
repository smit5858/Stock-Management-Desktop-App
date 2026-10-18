-- 001_init: full schema.
-- Conventions (see docs/DESIGN.md): money = INTEGER paise, quantity = INTEGER milli-units
-- (*_milli), GST % = INTEGER basis points (*_bp), dates = TEXT 'YYYY-MM-DD'.
-- Business rows are never hard-deleted: is_deleted = 1 or status = 'cancelled'.
-- No BEGIN/COMMIT here: migrate.js wraps each file in a transaction.

-- ---------------------------------------------------------------- settings & sequences
CREATE TABLE settings (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);

CREATE TABLE sequences (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- sale_gst, sale_non_gst, sale_return, ...
  prefix      TEXT NOT NULL,
  next_value  INTEGER NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  pad_width   INTEGER NOT NULL DEFAULT 4,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);

CREATE TABLE gst_rates (
  id          INTEGER PRIMARY KEY,
  rate_bp     INTEGER NOT NULL UNIQUE CHECK (rate_bp BETWEEN 0 AND 10000),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_deleted  INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);

-- ---------------------------------------------------------------- products & stock
CREATE TABLE product_categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_product_categories_name ON product_categories(name COLLATE NOCASE) WHERE is_deleted = 0;

CREATE TABLE products (
  id               INTEGER PRIMARY KEY,
  code             TEXT,                               -- SKU / barcode, optional
  name             TEXT NOT NULL,
  category_id      INTEGER REFERENCES product_categories(id),
  unit             TEXT NOT NULL DEFAULT 'pcs',
  hsn_code         TEXT,                               -- printed on GST invoices only
  purchase_price   INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price    INTEGER NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  gst_rate_bp      INTEGER NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  min_stock_milli  INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_milli >= 0),
  avg_cost         INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),  -- weighted average, per unit
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_products_code ON products(code COLLATE NOCASE)
  WHERE is_deleted = 0 AND code IS NOT NULL AND code <> '';
CREATE INDEX ix_products_name ON products(name COLLATE NOCASE);
CREATE INDEX ix_products_category ON products(category_id);

-- Append-only. Stock = SUM(qty_milli). Reversals are new rows.
CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  date        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN
                ('opening','purchase','purchase_return','sale','sale_return','adjustment')),
  qty_milli   INTEGER NOT NULL CHECK (qty_milli <> 0),  -- + in, - out
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  ref_type    TEXT,                                     -- 'sale_item', 'purchase_item', ...
  ref_id      INTEGER,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_stock_movements_product_date ON stock_movements(product_id, date, id);
CREATE INDEX ix_stock_movements_ref ON stock_movements(ref_type, ref_id);

CREATE VIEW v_product_stock AS
  SELECT p.id AS product_id, COALESCE(SUM(m.qty_milli), 0) AS stock_milli
  FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
  GROUP BY p.id;

-- ---------------------------------------------------------------- parties
CREATE TABLE parties (
  id               INTEGER PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('customer','supplier','both')),
  name             TEXT NOT NULL,
  phone            TEXT,
  address          TEXT,
  gstin            TEXT,
  state_code       TEXT,                 -- 2-digit GST state code; NULL = business state
  opening_balance  INTEGER NOT NULL DEFAULT 0,  -- + they owe us, - we owe them
  notes            TEXT,
  is_system        INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),  -- Cash Customer
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_parties_name ON parties(name COLLATE NOCASE);
CREATE INDEX ix_parties_phone ON parties(phone);

-- ---------------------------------------------------------------- purchases
CREATE TABLE purchases (
  id                   INTEGER PRIMARY KEY,
  party_id             INTEGER NOT NULL REFERENCES parties(id),
  bill_no              TEXT,                      -- supplier's bill number
  bill_date            TEXT NOT NULL,
  bill_type            TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  price_mode           TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')),
  supplier_gstin       TEXT,                      -- snapshot
  supplier_state_code  TEXT,                      -- snapshot
  is_interstate        INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  sub_total            INTEGER NOT NULL DEFAULT 0,
  item_discount_total  INTEGER NOT NULL DEFAULT 0,
  bill_discount        INTEGER NOT NULL DEFAULT 0,
  taxable_total        INTEGER NOT NULL DEFAULT 0,
  cgst_total           INTEGER NOT NULL DEFAULT 0,
  sgst_total           INTEGER NOT NULL DEFAULT 0,
  igst_total           INTEGER NOT NULL DEFAULT 0,
  tax_total            INTEGER NOT NULL DEFAULT 0,
  round_off            INTEGER NOT NULL DEFAULT 0,
  grand_total          INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason        TEXT,
  cancelled_at         TEXT,
  notes                TEXT,
  is_deleted           INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchases_date ON purchases(bill_date);
CREATE INDEX ix_purchases_party ON purchases(party_id);

CREATE TABLE purchase_items (
  id            INTEGER PRIMARY KEY,
  purchase_id   INTEGER NOT NULL REFERENCES purchases(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,                    -- snapshots
  unit          TEXT NOT NULL,
  hsn_code      TEXT,
  qty_milli     INTEGER NOT NULL CHECK (qty_milli > 0),
  rate          INTEGER NOT NULL CHECK (rate >= 0),
  discount      INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  gst_rate_bp   INTEGER NOT NULL DEFAULT 0,
  taxable       INTEGER NOT NULL,
  cgst          INTEGER NOT NULL DEFAULT 0,
  sgst          INTEGER NOT NULL DEFAULT 0,
  igst          INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX ix_purchase_items_product ON purchase_items(product_id);

CREATE TABLE purchase_returns (
  id             INTEGER PRIMARY KEY,
  return_no      TEXT NOT NULL UNIQUE,
  purchase_id    INTEGER REFERENCES purchases(id),
  party_id       INTEGER NOT NULL REFERENCES parties(id),
  date           TEXT NOT NULL,
  bill_type      TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  is_interstate  INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  taxable_total  INTEGER NOT NULL DEFAULT 0,
  cgst_total     INTEGER NOT NULL DEFAULT 0,
  sgst_total     INTEGER NOT NULL DEFAULT 0,
  igst_total     INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  round_off      INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_returns_date ON purchase_returns(date);
CREATE INDEX ix_purchase_returns_party ON purchase_returns(party_id);
CREATE INDEX ix_purchase_returns_purchase ON purchase_returns(purchase_id);

CREATE TABLE purchase_return_items (
  id                  INTEGER PRIMARY KEY,
  purchase_return_id  INTEGER NOT NULL REFERENCES purchase_returns(id),
  purchase_item_id    INTEGER REFERENCES purchase_items(id),
  product_id          INTEGER NOT NULL REFERENCES products(id),
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  rate                INTEGER NOT NULL CHECK (rate >= 0),
  gst_rate_bp         INTEGER NOT NULL DEFAULT 0,
  taxable             INTEGER NOT NULL,
  cgst                INTEGER NOT NULL DEFAULT 0,
  sgst                INTEGER NOT NULL DEFAULT 0,
  igst                INTEGER NOT NULL DEFAULT 0,
  line_total          INTEGER NOT NULL,
  unit_cost           INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_purchase_return_items_return ON purchase_return_items(purchase_return_id);
CREATE INDEX ix_purchase_return_items_product ON purchase_return_items(product_id);

-- ---------------------------------------------------------------- sales
CREATE TABLE sales (
  id                    INTEGER PRIMARY KEY,
  invoice_no            TEXT NOT NULL UNIQUE,     -- prefix + padded seq_no, e.g. GST-0001
  series                TEXT NOT NULL,            -- sequences.name: sale_gst | sale_non_gst
  seq_no                INTEGER NOT NULL,
  invoice_date          TEXT NOT NULL,
  bill_type             TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),
  price_mode            TEXT NOT NULL CHECK (price_mode IN ('inclusive','exclusive')),
  bill_title            TEXT NOT NULL,            -- "Tax Invoice" / "Bill of Supply" / "Estimate"
  party_id              INTEGER NOT NULL REFERENCES parties(id),
  customer_name         TEXT,                     -- snapshots (name may be typed for Cash Customer)
  customer_phone        TEXT,
  customer_address      TEXT,
  customer_gstin        TEXT,
  place_of_supply_code  TEXT NOT NULL,
  is_interstate         INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  sub_total             INTEGER NOT NULL DEFAULT 0,
  item_discount_total   INTEGER NOT NULL DEFAULT 0,
  bill_discount         INTEGER NOT NULL DEFAULT 0,
  taxable_total         INTEGER NOT NULL DEFAULT 0,
  cgst_total            INTEGER NOT NULL DEFAULT 0,
  sgst_total            INTEGER NOT NULL DEFAULT 0,
  igst_total            INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  round_off             INTEGER NOT NULL DEFAULT 0,
  grand_total           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason         TEXT,
  cancelled_at          TEXT,
  notes                 TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  UNIQUE (series, seq_no)
);
CREATE INDEX ix_sales_date ON sales(invoice_date);
CREATE INDEX ix_sales_party ON sales(party_id);
CREATE INDEX ix_sales_type_date ON sales(bill_type, invoice_date);

CREATE TABLE sale_items (
  id            INTEGER PRIMARY KEY,
  sale_id       INTEGER NOT NULL REFERENCES sales(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,                    -- snapshots for reprinting
  unit          TEXT NOT NULL,
  hsn_code      TEXT,
  qty_milli     INTEGER NOT NULL CHECK (qty_milli > 0),
  rate          INTEGER NOT NULL CHECK (rate >= 0),
  discount      INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  gst_rate_bp   INTEGER NOT NULL DEFAULT 0,
  taxable       INTEGER NOT NULL,
  cgst          INTEGER NOT NULL DEFAULT 0,
  sgst          INTEGER NOT NULL DEFAULT 0,
  igst          INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  unit_cost     INTEGER NOT NULL DEFAULT 0,       -- avg_cost at time of sale (COGS)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX ix_sale_items_product ON sale_items(product_id);

CREATE TABLE sale_returns (
  id             INTEGER PRIMARY KEY,
  return_no      TEXT NOT NULL UNIQUE,            -- credit note number
  sale_id        INTEGER NOT NULL REFERENCES sales(id),
  party_id       INTEGER NOT NULL REFERENCES parties(id),
  date           TEXT NOT NULL,
  bill_type      TEXT NOT NULL CHECK (bill_type IN ('gst','non_gst')),  -- inherited from sale
  is_interstate  INTEGER NOT NULL DEFAULT 0 CHECK (is_interstate IN (0,1)),
  taxable_total  INTEGER NOT NULL DEFAULT 0,
  cgst_total     INTEGER NOT NULL DEFAULT 0,
  sgst_total     INTEGER NOT NULL DEFAULT 0,
  igst_total     INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  round_off      INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_returns_date ON sale_returns(date);
CREATE INDEX ix_sale_returns_party ON sale_returns(party_id);
CREATE INDEX ix_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE sale_return_items (
  id              INTEGER PRIMARY KEY,
  sale_return_id  INTEGER NOT NULL REFERENCES sale_returns(id),
  sale_item_id    INTEGER NOT NULL REFERENCES sale_items(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  qty_milli       INTEGER NOT NULL CHECK (qty_milli > 0),
  rate            INTEGER NOT NULL CHECK (rate >= 0),
  gst_rate_bp     INTEGER NOT NULL DEFAULT 0,
  taxable         INTEGER NOT NULL,
  cgst            INTEGER NOT NULL DEFAULT 0,
  sgst            INTEGER NOT NULL DEFAULT 0,
  igst            INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  unit_cost       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_sale_return_items_return ON sale_return_items(sale_return_id);
CREATE INDEX ix_sale_return_items_item ON sale_return_items(sale_item_id);
CREATE INDEX ix_sale_return_items_product ON sale_return_items(product_id);

-- ---------------------------------------------------------------- accounts
CREATE TABLE accounts (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('cash','bank','upi')),
  opening_balance  INTEGER NOT NULL DEFAULT 0,
  is_system        INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_accounts_name ON accounts(name COLLATE NOCASE) WHERE is_deleted = 0;

CREATE TABLE payments (
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
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_payments_date ON payments(date);
CREATE INDEX ix_payments_party ON payments(party_id);
CREATE INDEX ix_payments_account ON payments(account_id, date);
CREATE INDEX ix_payments_ref ON payments(ref_type, ref_id);

CREATE TABLE account_transfers (
  id               INTEGER PRIMARY KEY,
  date             TEXT NOT NULL,
  from_account_id  INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id    INTEGER NOT NULL REFERENCES accounts(id),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  notes            TEXT,
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX ix_account_transfers_date ON account_transfers(date);

CREATE TABLE expense_categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE UNIQUE INDEX ux_expense_categories_name ON expense_categories(name COLLATE NOCASE) WHERE is_deleted = 0;

CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY,
  date           TEXT NOT NULL,
  category_id    INTEGER NOT NULL REFERENCES expense_categories(id),
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
);
CREATE INDEX ix_expenses_date ON expenses(date);
CREATE INDEX ix_expenses_category ON expenses(category_id);

-- ---------------------------------------------------------------- updated_at triggers
-- Only fire when the UPDATE did not set updated_at itself (avoids recursion).
CREATE TRIGGER trg_settings_updated AFTER UPDATE ON settings FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE settings SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sequences_updated AFTER UPDATE ON sequences FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sequences SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_gst_rates_updated AFTER UPDATE ON gst_rates FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE gst_rates SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_product_categories_updated AFTER UPDATE ON product_categories FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE product_categories SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_products_updated AFTER UPDATE ON products FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE products SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_parties_updated AFTER UPDATE ON parties FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE parties SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchases_updated AFTER UPDATE ON purchases FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchases SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_purchase_returns_updated AFTER UPDATE ON purchase_returns FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE purchase_returns SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sales_updated AFTER UPDATE ON sales FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sales SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_sale_returns_updated AFTER UPDATE ON sale_returns FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE sale_returns SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_accounts_updated AFTER UPDATE ON accounts FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE accounts SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_payments_updated AFTER UPDATE ON payments FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE payments SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_account_transfers_updated AFTER UPDATE ON account_transfers FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE account_transfers SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_expense_categories_updated AFTER UPDATE ON expense_categories FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE expense_categories SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;
CREATE TRIGGER trg_expenses_updated AFTER UPDATE ON expenses FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE expenses SET updated_at = strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id = NEW.id; END;

-- Stock movements are immutable once written; corrections are new reversing rows.
CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
  BEGIN SELECT RAISE(ABORT, 'stock_movements are append-only'); END;
CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
  BEGIN SELECT RAISE(ABORT, 'stock_movements are append-only'); END;

-- 002_seed: default rows. Values here are editable later from Settings.

INSERT INTO settings (key, value) VALUES
  ('business_name', ''),
  ('business_address', ''),
  ('business_phone', ''),
  ('business_email', ''),
  ('business_gstin', ''),
  ('business_state_code', ''),          -- 2-digit GST state code, set in Settings
  ('business_logo', ''),                -- data URL, kept in the DB so it is backed up
  ('invoice_footer', 'Thank you for your business!'),
  ('default_bill_type', 'gst'),         -- gst | non_gst
  ('default_price_mode', 'exclusive'),  -- inclusive | exclusive
  ('non_gst_bill_title', 'Bill of Supply'),
  ('composition_dealer', '0'),          -- 1 = force all sales to non-GST, no tax
  ('pin_hash', ''),
  ('pin_salt', '');

INSERT INTO sequences (name, prefix, pad_width) VALUES
  ('sale_gst', 'GST-', 4),
  ('sale_non_gst', 'EST-', 4),
  ('sale_return', 'CN-', 4),
  ('purchase_return', 'DN-', 4),
  ('payment_in', 'RCT-', 4),
  ('payment_out', 'PAY-', 4);

INSERT INTO gst_rates (rate_bp, sort_order) VALUES
  (0, 1), (500, 2), (1800, 3), (4000, 4);

INSERT INTO product_categories (name) VALUES ('General');

INSERT INTO parties (type, name, is_system) VALUES ('customer', 'Cash Customer', 1);

INSERT INTO accounts (name, type, is_system) VALUES
  ('Cash', 'cash', 1),
  ('Bank', 'bank', 1),
  ('UPI', 'upi', 1);

INSERT INTO expense_categories (name) VALUES
  ('Rent'), ('Electricity'), ('Salary'), ('Transport'), ('Telephone & Internet'),
  ('Repairs & Maintenance'), ('Office Supplies'), ('Miscellaneous');

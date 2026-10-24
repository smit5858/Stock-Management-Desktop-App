-- 002_seed: default rows. Values here are editable later from Settings.
-- The logo and startup sound are files in data/branding/ (not stored in the DB).

INSERT INTO settings (key, value) VALUES
  ('business_name', 'Pragati Car'),
  ('business_address', ''),
  ('business_phone', ''),
  ('business_email', ''),
  ('business_gstin', ''),
  ('business_state_code', ''),          -- 2-digit GST state code, set in Settings
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
  ('sale_return_gst', 'CN-GST-', 4),       -- credit notes against GST invoices
  ('sale_return_non_gst', 'CN-EST-', 4),   -- credit notes against non-GST bills
  ('purchase_return', 'DN-', 4),
  ('payment_in', 'RCT-', 4),
  ('payment_out', 'PAY-', 4),
  ('product_sku', 'PC-', 5);               -- auto SKU when left blank

INSERT INTO gst_rates (rate_bp, sort_order) VALUES
  (0, 1), (500, 2), (1800, 3), (4000, 4);

INSERT INTO product_categories (name, sort_order) VALUES
  ('Seat Covers', 1),
  ('Floor Mats', 2),
  ('Steering Covers', 3),
  ('Music Systems & Speakers', 4),
  ('Lights & LEDs', 5),
  ('Car Perfumes', 6),
  ('Body Covers', 7),
  ('Cameras & Sensors', 8),
  ('Mobile Holders & Chargers', 9),
  ('Cleaning & Care', 10),
  ('Wipers', 11),
  ('Horns', 12),
  ('Interior Accessories', 13),
  ('Exterior Accessories', 14),
  ('Fitting Charges', 15);

-- Common Indian car models (make/model names only, for compatibility search). Editable.
INSERT INTO vehicle_models (make, model) VALUES
  ('Maruti Suzuki', 'Alto'), ('Maruti Suzuki', 'Alto K10'), ('Maruti Suzuki', 'S-Presso'),
  ('Maruti Suzuki', 'Celerio'), ('Maruti Suzuki', 'WagonR'), ('Maruti Suzuki', 'Swift'),
  ('Maruti Suzuki', 'Dzire'), ('Maruti Suzuki', 'Baleno'), ('Maruti Suzuki', 'Ignis'),
  ('Maruti Suzuki', 'Fronx'), ('Maruti Suzuki', 'Brezza'), ('Maruti Suzuki', 'Ertiga'),
  ('Maruti Suzuki', 'XL6'), ('Maruti Suzuki', 'Ciaz'), ('Maruti Suzuki', 'Grand Vitara'),
  ('Maruti Suzuki', 'Eeco'), ('Maruti Suzuki', 'Jimny'),
  ('Hyundai', 'Grand i10 Nios'), ('Hyundai', 'i20'), ('Hyundai', 'Aura'), ('Hyundai', 'Exter'),
  ('Hyundai', 'Venue'), ('Hyundai', 'Creta'), ('Hyundai', 'Verna'), ('Hyundai', 'Alcazar'),
  ('Hyundai', 'Tucson'),
  ('Tata', 'Tiago'), ('Tata', 'Tigor'), ('Tata', 'Altroz'), ('Tata', 'Punch'), ('Tata', 'Nexon'),
  ('Tata', 'Curvv'), ('Tata', 'Harrier'), ('Tata', 'Safari'),
  ('Mahindra', 'Bolero'), ('Mahindra', 'Bolero Neo'), ('Mahindra', 'Thar'), ('Mahindra', 'XUV 3XO'),
  ('Mahindra', 'XUV300'), ('Mahindra', 'Scorpio Classic'), ('Mahindra', 'Scorpio-N'),
  ('Mahindra', 'XUV700'),
  ('Kia', 'Sonet'), ('Kia', 'Seltos'), ('Kia', 'Carens'),
  ('Toyota', 'Glanza'), ('Toyota', 'Urban Cruiser Hyryder'), ('Toyota', 'Innova Crysta'),
  ('Toyota', 'Innova Hycross'), ('Toyota', 'Fortuner'),
  ('Honda', 'Amaze'), ('Honda', 'City'), ('Honda', 'Elevate'),
  ('Renault', 'Kwid'), ('Renault', 'Triber'), ('Renault', 'Kiger'),
  ('Nissan', 'Magnite'),
  ('MG', 'Comet EV'), ('MG', 'Astor'), ('MG', 'Hector'), ('MG', 'Windsor EV'),
  ('Skoda', 'Kushaq'), ('Skoda', 'Slavia'), ('Skoda', 'Kylaq'),
  ('Volkswagen', 'Taigun'), ('Volkswagen', 'Virtus');

INSERT INTO parties (type, name, is_system) VALUES ('customer', 'Cash Customer', 1);

INSERT INTO accounts (name, type, is_system) VALUES
  ('Cash', 'cash', 1),
  ('Bank', 'bank', 1),
  ('UPI', 'upi', 1);

INSERT INTO expense_categories (name) VALUES
  ('Rent'), ('Electricity'), ('Salary'), ('Transport'), ('Telephone & Internet'),
  ('Repairs & Maintenance'), ('Office Supplies'), ('Miscellaneous');

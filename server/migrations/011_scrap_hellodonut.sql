-- The starter promo code HELLODONUT handed out a second Free Cream Cheese Donut on top of the
-- welcome gift (2026-10-30, Anson: "scrap it"). Switch it off; vouchers already issued stay valid.
UPDATE promo_codes SET active = false WHERE code = 'HELLODONUT';

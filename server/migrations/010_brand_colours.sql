-- Brand colours from the O! Donut illustration (2026-10-28): a dusty salmon card with deep cobalt
-- text and navy labels, the same look as the shop's artwork. Only changes shops still on one of
-- the earlier default colour sets, so colours chosen in Settings are kept.
ALTER TABLE program ALTER COLUMN background_color SET DEFAULT '#F2B4A7';
ALTER TABLE program ALTER COLUMN foreground_color SET DEFAULT '#004A94';
ALTER TABLE program ALTER COLUMN label_color SET DEFAULT '#14223F';
UPDATE program SET background_color = '#F2B4A7', foreground_color = '#004A94', label_color = '#14223F', updated_at = now()
 WHERE id = 1 AND (
   (upper(background_color) = '#1F1B22' AND upper(foreground_color) = '#FFFFFF' AND upper(label_color) = '#F7A8C4')
   OR (upper(background_color) = '#F25C8A' AND upper(foreground_color) = '#3B1F14' AND upper(label_color) = '#FFFFFF')
 );

-- Tier badges in the same family: terracotta, cobalt, antique gold (only untouched defaults).
ALTER TABLE tiers ALTER COLUMN color SET DEFAULT '#0055A5';
UPDATE tiers SET color = '#C0614E' WHERE name = 'Sprinkle' AND upper(color) = '#F25C8A';
UPDATE tiers SET color = '#0055A5' WHERE name = 'Glazed' AND upper(color) = '#C8742B';
UPDATE tiers SET color = '#9A7428' WHERE name = 'Golden' AND upper(color) = '#B8860B';

-- Wallet passes pick up the new colours and artwork on their next refresh.
UPDATE cards SET updated_at = now() WHERE EXISTS (SELECT 1 FROM program WHERE id = 1 AND background_color = '#F2B4A7');

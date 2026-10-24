-- Refined default look (2026-10-24): a deep charcoal card with white text and soft pink labels,
-- replacing the first placeholder pink. Only changes shops still on the old default colours.
ALTER TABLE program ALTER COLUMN background_color SET DEFAULT '#1F1B22';
ALTER TABLE program ALTER COLUMN foreground_color SET DEFAULT '#FFFFFF';
ALTER TABLE program ALTER COLUMN label_color SET DEFAULT '#F7A8C4';
UPDATE program SET background_color = '#1F1B22', foreground_color = '#FFFFFF', label_color = '#F7A8C4', updated_at = now()
 WHERE id = 1 AND upper(background_color) = '#F25C8A' AND upper(foreground_color) = '#3B1F14' AND upper(label_color) = '#FFFFFF';
-- Wallet passes pick up the new colours on their next refresh.
UPDATE cards SET updated_at = now() WHERE EXISTS (SELECT 1 FROM program WHERE id = 1 AND background_color = '#1F1B22');

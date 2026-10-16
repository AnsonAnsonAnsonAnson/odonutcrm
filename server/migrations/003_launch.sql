-- Launch tools: a timed stamp multiplier ("double stamps for the first two weeks").
ALTER TABLE program ADD COLUMN stamp_multiplier int NOT NULL DEFAULT 1 CHECK (stamp_multiplier BETWEEN 1 AND 5);
ALTER TABLE program ADD COLUMN multiplier_starts_at timestamptz;
ALTER TABLE program ADD COLUMN multiplier_ends_at timestamptz;
ALTER TABLE program ADD COLUMN multiplier_label text NOT NULL DEFAULT 'Double stamps';

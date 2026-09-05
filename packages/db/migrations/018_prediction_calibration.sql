ALTER TABLE decision
  ADD COLUMN predicted_p        NUMERIC,
  ADD COLUMN predicted_evidence INT,
  ADD COLUMN predicted_level    TEXT;

CREATE INDEX decision_predicted_p_idx ON decision (predicted_p) WHERE predicted_p IS NOT NULL;

COMMENT ON COLUMN decision.predicted_p IS
  'What the model believed, at the moment it decided, about the chance this attempt would be captured. Stored rather than recomputed, because the model moves as evidence arrives and a prediction can only be scored against the belief that was actually acted on.';

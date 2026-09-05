ALTER TABLE merchant
  ADD COLUMN halted_at   TIMESTAMPTZ,
  ADD COLUMN halt_reason TEXT;

COMMENT ON COLUMN merchant.halted_at IS
  'When this merchant stopped their own charging. A halt belongs to one account: one business pausing must never stop another. The flag in control_flags stays as an operator-wide stop for incidents, and is no longer reachable from a merchant dashboard.';

UPDATE control_flags
   SET kill_switch = FALSE,
       kill_switch_reason = 'Cleared by migration 019. The dashboard control that set this halted every merchant at once, which was a bug; it now halts only the account that pressed it.',
       updated_at = clock_timestamp()
 WHERE id = 1 AND kill_switch;

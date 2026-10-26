-- A payment attempt can also end with "the provider could not be reached": nothing was sent, so
-- nothing was charged. Recording it as "declined" would claim the card was refused.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'succeeded', 'declined', 'timeout', 'unreachable'));

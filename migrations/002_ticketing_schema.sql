-- Ticketing schema. Replaces the generic products/orders tables from 001.
-- users (from 001) is kept: SERIAL id, lower-cased email (normalized by the API), role.

DROP TABLE order_items;
DROP TABLE orders;
DROP TABLE products;

CREATE TABLE venues (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id             bigint NOT NULL REFERENCES venues (id),
  name                 text NOT NULL,
  starts_at            timestamptz NOT NULL,
  onsale_at            timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'onsale', 'soldout', 'ended')),
  max_seats_per_user   int NOT NULL DEFAULT 6 CHECK (max_seats_per_user > 0),
  waiting_room_enabled boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- One row per physical seat per event: inventory is per event, so two events at the
-- same venue never contend for the same row.
CREATE TABLE seats (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    bigint NOT NULL REFERENCES events (id),
  section     text NOT NULL,
  row_label   text NOT NULL,
  number      int NOT NULL,
  price_cents int NOT NULL CHECK (price_cents > 0),
  status      text NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'held', 'sold')),
  held_by     integer REFERENCES users (id),
  held_until  timestamptz,
  version     int NOT NULL DEFAULT 0,
  UNIQUE (event_id, section, row_label, number),
  -- A held seat always knows who holds it and until when; other states carry neither.
  CHECK ((status = 'held') = (held_by IS NOT NULL AND held_until IS NOT NULL))
);
CREATE INDEX seats_event_section_status ON seats (event_id, section, status);
-- Partial: only held rows, the ones the per-user limit and "my holds" queries scan.
CREATE INDEX seats_held_by ON seats (event_id, held_by) WHERE status = 'held';

-- UUID ids: created by many API instances at once and exposed in URLs, so they must be
-- unguessable and need no central sequence. Seats stay bigint: created once by the seed,
-- never enumerable in a way that matters, and 8 bytes keep the hottest indexes small.
CREATE TABLE orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     integer NOT NULL REFERENCES users (id),
  event_id    bigint NOT NULL REFERENCES events (id),
  status      text NOT NULL
              CHECK (status IN ('pending_payment', 'paid', 'issued', 'failed', 'expired')),
  total_cents int NOT NULL CHECK (total_cents > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user ON orders (user_id, created_at DESC);

CREATE TABLE order_items (
  order_id    uuid NOT NULL REFERENCES orders (id),
  seat_id     bigint NOT NULL REFERENCES seats (id),
  price_cents int NOT NULL,
  PRIMARY KEY (order_id, seat_id)
);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders (id),
  attempt      int NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'declined', 'timeout')),
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, attempt)
);

CREATE TABLE tickets (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  uuid NOT NULL REFERENCES orders (id),
  event_id  bigint NOT NULL REFERENCES events (id),
  -- Last line of defense against overselling: if the hold/sell logic ever lets two orders
  -- through for one seat, the second ticket insert fails and its transaction rolls back.
  -- Correctness must not depend on it; it turns a silent double sale into a loud error.
  seat_id   bigint NOT NULL UNIQUE REFERENCES seats (id),
  code      text NOT NULL UNIQUE, -- random token rendered as a QR code
  issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_order ON tickets (order_id);

CREATE TABLE idempotency_keys (
  user_id       integer NOT NULL REFERENCES users (id),
  key           text NOT NULL,
  request_hash  text NOT NULL,
  state         text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Scoped per user: one client's key can never replay another user's response.
  PRIMARY KEY (user_id, key)
);

-- RoomSink initial schema. All tables InnoDB / utf8mb4.
CREATE TABLE rooms (
  code CHAR(6) NOT NULL PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  owner VARCHAR(255) NOT NULL,
  status ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  purpose ENUM('teaching','research') NOT NULL DEFAULT 'teaching',
  public_config JSON NOT NULL,
  limits JSON NOT NULL,
  presenter_key_hash CHAR(64) NULL,
  next_seq BIGINT NOT NULL DEFAULT 1,
  event_count INT NOT NULL DEFAULT 0,
  bytes_used INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  closes_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_rooms_owner (owner),
  INDEX idx_rooms_expires (expires_at),
  INDEX idx_rooms_status_closes (status, closes_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE room_owners (
  room CHAR(6) NOT NULL,
  staff_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (room, staff_id),
  INDEX idx_room_owners_staff (staff_id),
  CONSTRAINT fk_room_owners_room FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE apps (
  room CHAR(6) NOT NULL,
  name VARCHAR(40) NOT NULL,
  enabled BOOL NOT NULL DEFAULT TRUE,
  max_events_per_client INT NOT NULL DEFAULT 100,
  allow_free_text BOOL NOT NULL DEFAULT FALSE,
  `groups` JSON NULL,
  config JSON NOT NULL,
  `schema` JSON NULL,
  PRIMARY KEY (room, name),
  CONSTRAINT fk_apps_room FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE clients (
  room CHAR(6) NOT NULL,
  cid CHAR(26) NOT NULL,
  joined_at DATETIME(3) NOT NULL,
  `groups` JSON NOT NULL,
  deleted BOOL NOT NULL DEFAULT FALSE,
  PRIMARY KEY (room, cid),
  CONSTRAINT fk_clients_room FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE events (
  id CHAR(26) NOT NULL PRIMARY KEY,
  room CHAR(6) NOT NULL,
  seq BIGINT NOT NULL,
  app VARCHAR(40) NOT NULL,
  cid CHAR(26) NOT NULL,
  t DATETIME(3) NOT NULL,
  client_t BIGINT NULL,
  app_version VARCHAR(20) NULL,
  data JSON NOT NULL,
  UNIQUE KEY uq_events_room_seq (room, seq),
  INDEX idx_events_room_app_seq (room, app, seq),
  INDEX idx_events_room_cid (room, cid, app),
  CONSTRAINT fk_events_room FOREIGN KEY (room) REFERENCES rooms(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE idempotency (
  room CHAR(6) NOT NULL,
  cid CHAR(26) NOT NULL,
  `key` VARCHAR(64) NOT NULL,
  event_id CHAR(26) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (room, cid, `key`),
  INDEX idx_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE retired_codes (
  code CHAR(6) NOT NULL PRIMARY KEY,
  retired_at DATETIME(3) NOT NULL,
  INDEX idx_retired_at (retired_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ws_tickets (
  ticket CHAR(43) NOT NULL PRIMARY KEY,
  room CHAR(6) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_ws_tickets_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

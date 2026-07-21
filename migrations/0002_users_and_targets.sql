ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'parent';

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

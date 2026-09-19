CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL,
  role VARCHAR(16) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS tags (
  name VARCHAR(32) PRIMARY KEY,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id BIGINT NOT NULL,
  tag_name VARCHAR(32) NOT NULL,
  PRIMARY KEY (post_id, tag_name)
);

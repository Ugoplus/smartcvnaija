CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  is_remote BOOLEAN DEFAULT FALSE,
  email TEXT NOT NULL
);

CREATE TABLE payments (
  user_identifier TEXT PRIMARY KEY,
  payment_status TEXT NOT NULL,
  payment_reference TEXT NOT NULL
);

CREATE TABLE applications (
  id UUID PRIMARY KEY,
  user_identifier TEXT NOT NULL,
  job_id UUID REFERENCES jobs(id),
  cv_text TEXT NOT NULL,
  cv_score JSONB
);
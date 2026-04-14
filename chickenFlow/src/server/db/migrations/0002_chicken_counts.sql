CREATE TABLE IF NOT EXISTS "chicken_counts" (
  "date" text PRIMARY KEY,
  "total_in" integer DEFAULT 0 NOT NULL,
  "total_out" integer DEFAULT 0 NOT NULL,
  "net_inside" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

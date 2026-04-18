ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "manual_override_until" timestamp with time zone;

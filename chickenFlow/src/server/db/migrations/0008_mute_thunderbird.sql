ALTER TABLE "device_status" ADD COLUMN "light_level" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "light_threshold" integer DEFAULT 2000 NOT NULL;
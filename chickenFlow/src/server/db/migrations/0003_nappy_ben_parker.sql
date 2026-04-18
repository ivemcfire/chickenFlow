DROP INDEX IF EXISTS "camera_captures_is_anomaly_idx";--> statement-breakpoint
ALTER TABLE "ai_analysis_log" DROP COLUMN IF EXISTS "has_image";--> statement-breakpoint
ALTER TABLE "ai_analysis_log" DROP COLUMN IF EXISTS "anomaly_detected";--> statement-breakpoint
ALTER TABLE "ai_analysis_log" DROP COLUMN IF EXISTS "threat_type";--> statement-breakpoint
ALTER TABLE "camera_captures" DROP COLUMN IF EXISTS "is_anomaly";--> statement-breakpoint
ALTER TABLE "camera_captures" DROP COLUMN IF EXISTS "threat_type";--> statement-breakpoint
ALTER TABLE "camera_captures" DROP COLUMN IF EXISTS "ai_analysis_id";

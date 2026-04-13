CREATE TABLE "ai_analysis_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text DEFAULT 'gemini-2.5-flash-lite' NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"has_image" boolean DEFAULT false NOT NULL,
	"door_state" text NOT NULL,
	"chickens_inside" integer NOT NULL,
	"total_chickens" integer NOT NULL,
	"weather_code" integer,
	"temp_max" double precision,
	"weather_lock" boolean DEFAULT false NOT NULL,
	"service_mode" boolean DEFAULT false NOT NULL,
	"obstruction_distance" double precision,
	"context_note" text,
	"analysis_text" text,
	"is_warning" boolean DEFAULT false NOT NULL,
	"anomaly_detected" boolean,
	"threat_type" text,
	"count_confirmed" boolean,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "camera_captures" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" integer,
	"width_px" integer,
	"height_px" integer,
	"door_state_at_capture" text,
	"chickens_inside_at_capture" integer,
	"is_anomaly" boolean DEFAULT false NOT NULL,
	"threat_type" text,
	"ai_analysis_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "door_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"trigger" text NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"chickens_inside" integer,
	"total_chickens" integer,
	"obstruction_distance" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_readings" (
	"id" serial PRIMARY KEY NOT NULL,
	"distance_cm" double precision,
	"top_sensor_triggered" boolean DEFAULT false NOT NULL,
	"ir_triggered" boolean DEFAULT false NOT NULL,
	"chickens_inside" integer NOT NULL,
	"total_chickens" integer NOT NULL,
	"door_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"total_chickens" integer DEFAULT 10 NOT NULL,
	"service_mode" boolean DEFAULT false NOT NULL,
	"automatic_door" boolean DEFAULT true NOT NULL,
	"music_duration" integer DEFAULT 5 NOT NULL,
	"smart_night_light" boolean DEFAULT true NOT NULL,
	"location_lat" double precision DEFAULT 51.5074 NOT NULL,
	"location_lon" double precision DEFAULT -0.1278 NOT NULL,
	"pending_command" text DEFAULT 'NONE' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"timestamp" text NOT NULL,
	"is_warning" boolean DEFAULT false NOT NULL,
	"is_error" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"forecast_date" text NOT NULL,
	"weather_code" integer NOT NULL,
	"temp_max" double precision NOT NULL,
	"temp_min" double precision NOT NULL,
	"sunrise" text NOT NULL,
	"sunset" text NOT NULL,
	"is_severe" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_cache_forecast_date_unique" UNIQUE("forecast_date")
);
--> statement-breakpoint
CREATE INDEX "ai_log_created_at_idx" ON "ai_analysis_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "camera_captures_created_at_idx" ON "camera_captures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "camera_captures_is_anomaly_idx" ON "camera_captures" USING btree ("is_anomaly");--> statement-breakpoint
CREATE INDEX "door_events_created_at_idx" ON "door_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "door_events_to_state_idx" ON "door_events" USING btree ("to_state");--> statement-breakpoint
CREATE INDEX "sensor_readings_created_at_idx" ON "sensor_readings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "status_messages_created_at_idx" ON "status_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "status_messages_is_pinned_idx" ON "status_messages" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "status_messages_category_idx" ON "status_messages" USING btree ("category");--> statement-breakpoint
CREATE INDEX "weather_cache_forecast_date_idx" ON "weather_cache" USING btree ("forecast_date");
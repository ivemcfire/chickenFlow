CREATE TABLE "ai_analysis_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chicken_counts" (
	"date" text PRIMARY KEY NOT NULL,
	"total_in" integer DEFAULT 0 NOT NULL,
	"total_out" integer DEFAULT 0 NOT NULL,
	"net_inside" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chicken_counts_total_in_check" CHECK ("chicken_counts"."total_in" >= 0),
	CONSTRAINT "chicken_counts_total_out_check" CHECK ("chicken_counts"."total_out" >= 0)
);
--> statement-breakpoint
CREATE TABLE "count_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"dir" text NOT NULL,
	"source" text DEFAULT 'beam' NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "count_events_dir_check" CHECK ("count_events"."dir" IN ('IN','OUT')),
	CONSTRAINT "count_events_source_check" CHECK ("count_events"."source" IN ('beam','camera'))
);
--> statement-breakpoint
CREATE TABLE "device_status" (
	"device_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"rssi" integer,
	"voltage_v" double precision,
	"current_ma" integer,
	"temp_c" double precision,
	"uptime_s" integer,
	"light_level" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "door_events_to_state_check" CHECK ("door_events"."to_state" IN ('OPEN','CLOSED','OPENING','CLOSING','ERROR')),
	CONSTRAINT "door_events_from_state_check" CHECK ("door_events"."from_state" IN ('OPEN','CLOSED','OPENING','CLOSING','ERROR','UNKNOWN'))
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
	"light_threshold" integer DEFAULT 2000 NOT NULL,
	"manual_override_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
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
CREATE INDEX "count_events_event_at_idx" ON "count_events" USING btree ("event_at");--> statement-breakpoint
CREATE INDEX "door_events_created_at_idx" ON "door_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "door_events_to_state_idx" ON "door_events" USING btree ("to_state");--> statement-breakpoint
CREATE INDEX "status_messages_created_at_idx" ON "status_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "status_messages_is_pinned_idx" ON "status_messages" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "status_messages_category_idx" ON "status_messages" USING btree ("category");--> statement-breakpoint
CREATE INDEX "weather_cache_forecast_date_idx" ON "weather_cache" USING btree ("forecast_date");
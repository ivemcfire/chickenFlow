CREATE TABLE `ai_analysis_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`has_image` integer DEFAULT false NOT NULL,
	`door_state` text NOT NULL,
	`chickens_inside` integer NOT NULL,
	`total_chickens` integer NOT NULL,
	`weather_code` integer,
	`temp_max` real,
	`weather_lock` integer DEFAULT false NOT NULL,
	`service_mode` integer DEFAULT false NOT NULL,
	`obstruction_distance` real,
	`context_note` text,
	`analysis_text` text,
	`is_warning` integer DEFAULT false NOT NULL,
	`anomaly_detected` integer,
	`threat_type` text,
	`count_confirmed` integer,
	`error_message` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_log_created_at_idx` ON `ai_analysis_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `camera_captures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_path` text NOT NULL,
	`file_size_bytes` integer,
	`width_px` integer,
	`height_px` integer,
	`door_state_at_capture` text,
	`chickens_inside_at_capture` integer,
	`is_anomaly` integer DEFAULT false NOT NULL,
	`threat_type` text,
	`ai_analysis_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `camera_captures_created_at_idx` ON `camera_captures` (`created_at`);--> statement-breakpoint
CREATE INDEX `camera_captures_is_anomaly_idx` ON `camera_captures` (`is_anomaly`);--> statement-breakpoint
CREATE TABLE `door_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`trigger` text NOT NULL,
	`is_manual` integer DEFAULT false NOT NULL,
	`chickens_inside` integer,
	`total_chickens` integer,
	`obstruction_distance` real,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `door_events_created_at_idx` ON `door_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `door_events_to_state_idx` ON `door_events` (`to_state`);--> statement-breakpoint
CREATE TABLE `sensor_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`distance_cm` real NOT NULL,
	`ir_triggered` integer DEFAULT false NOT NULL,
	`chickens_inside` integer NOT NULL,
	`total_chickens` integer NOT NULL,
	`door_state` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sensor_readings_created_at_idx` ON `sensor_readings` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`total_chickens` integer DEFAULT 10 NOT NULL,
	`service_mode` integer DEFAULT false NOT NULL,
	`automatic_door` integer DEFAULT true NOT NULL,
	`music_duration` integer DEFAULT 5 NOT NULL,
	`smart_night_light` integer DEFAULT true NOT NULL,
	`location_lat` real DEFAULT 51.5074 NOT NULL,
	`location_lon` real DEFAULT -0.1278 NOT NULL,
	`pending_command` text DEFAULT 'NONE' NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`timestamp` text NOT NULL,
	`is_warning` integer DEFAULT false NOT NULL,
	`is_error` integer DEFAULT false NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`category` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_messages_created_at_idx` ON `status_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `status_messages_is_pinned_idx` ON `status_messages` (`is_pinned`);--> statement-breakpoint
CREATE INDEX `status_messages_category_idx` ON `status_messages` (`category`);--> statement-breakpoint
CREATE TABLE `weather_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`forecast_date` text NOT NULL,
	`weather_code` integer NOT NULL,
	`temp_max` real NOT NULL,
	`temp_min` real NOT NULL,
	`sunrise` text NOT NULL,
	`sunset` text NOT NULL,
	`is_severe` integer DEFAULT false NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weather_cache_forecast_date_unique` ON `weather_cache` (`forecast_date`);--> statement-breakpoint
CREATE INDEX `weather_cache_forecast_date_idx` ON `weather_cache` (`forecast_date`);
CREATE TABLE "device_status" (
	"device_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"rssi" integer,
	"voltage_v" double precision,
	"current_ma" integer,
	"temp_c" double precision,
	"uptime_s" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

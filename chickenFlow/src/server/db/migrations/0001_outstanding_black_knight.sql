ALTER TABLE "sensor_readings" ALTER COLUMN "distance_cm" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD COLUMN "top_sensor_triggered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD COLUMN "ir_a_triggered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_readings" ADD COLUMN "ir_b_triggered" boolean DEFAULT false NOT NULL;
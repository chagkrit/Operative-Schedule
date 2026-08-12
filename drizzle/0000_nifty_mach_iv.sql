CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_date` text NOT NULL,
	`queue_type` text NOT NULL,
	`slot_no` integer NOT NULL,
	`diagnosis` text NOT NULL,
	`is_cancer` integer NOT NULL,
	`hn` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`phone` text NOT NULL,
	`operation` text NOT NULL,
	`staff` text NOT NULL,
	`calendar_event_id` text,
	`calendar_sync_status` text DEFAULT 'pending' NOT NULL,
	`booked_by_id` text NOT NULL,
	`booked_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_bookings_queue_slot` ON `bookings` (`schedule_date`,`queue_type`,`slot_no`);--> statement-breakpoint
CREATE INDEX `idx_bookings_schedule` ON `bookings` (`schedule_date`,`queue_type`);--> statement-breakpoint
CREATE TABLE `extra_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`capacity` integer DEFAULT 4 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_extra_days_date` ON `extra_days` (`date`);
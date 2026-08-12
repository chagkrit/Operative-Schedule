import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const extraDays = sqliteTable(
  "extra_days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    capacity: integer("capacity").notNull().default(4),
    note: text("note").notNull().default(""),
    createdByEmail: text("created_by_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("uq_extra_days_date").on(table.date)],
);

export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    scheduleDate: text("schedule_date").notNull(),
    queueType: text("queue_type", { enum: ["OR17", "EXTRA"] }).notNull(),
    slotNo: integer("slot_no").notNull(),
    diagnosis: text("diagnosis").notNull(),
    isCancer: integer("is_cancer", { mode: "boolean" }).notNull(),
    hn: text("hn").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone").notNull(),
    operation: text("operation").notNull(),
    staff: text("staff").notNull(),
    calendarEventId: text("calendar_event_id"),
    calendarSyncStatus: text("calendar_sync_status", {
      enum: ["pending", "synced", "failed"],
    })
      .notNull()
      .default("pending"),
    bookedById: text("booked_by_id").notNull(),
    bookedByEmail: text("booked_by_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_bookings_queue_slot").on(
      table.scheduleDate,
      table.queueType,
      table.slotNo,
    ),
    index("idx_bookings_schedule").on(table.scheduleDate, table.queueType),
  ],
);

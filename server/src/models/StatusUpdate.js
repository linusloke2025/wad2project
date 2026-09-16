import mongoose from 'mongoose'

import { STATUSES } from '../realtime/liveState.js'

/**
 * A recorded status change, kept for the post-event report.
 *
 * This is the durable counterpart to the in-memory live state. Live state is what the board
 * reads right now and is lost on restart; this is what survives the event, which is the whole
 * point of asking "where were the bottlenecks" afterwards.
 *
 * The enum is imported from the live state rather than duplicated, so a status the board can
 * accept is exactly a status the report can explain.
 *
 * Retention: the spec sets a 30-day post-event policy. Nothing here enforces that yet — it is a
 * deletion job, not a schema concern — but the `at` index makes such a sweep cheap.
 */

const statusUpdateSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    status: { type: String, required: true, enum: STATUSES },
    at: { type: Date, required: true },
  },
  { timestamps: true },
)

// The report reads one event's history in time order.
statusUpdateSchema.index({ eventId: 1, groupId: 1, at: 1 })

export const StatusUpdate =
  mongoose.models.StatusUpdate ?? mongoose.model('StatusUpdate', statusUpdateSchema)

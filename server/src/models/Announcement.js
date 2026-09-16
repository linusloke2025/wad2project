import mongoose from 'mongoose'

/**
 * A one-way broadcast from the planning team to the groups on the ground.
 *
 * `body` is the planner's message. It is deliberately the only text field in the announcement
 * model: there is no reply, thread or comment anywhere, because a reply box would make this chat
 * and the app exists to remove the messy-Telegram problem rather than rebuild Telegram.
 *
 * Group responses live in AnnouncementAck and are a fixed signal, not text.
 */

const announcementSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
)

// The board reads newest-first for one event.
announcementSchema.index({ eventId: 1, createdAt: -1 })

export const Announcement =
  mongoose.models.Announcement ?? mongoose.model('Announcement', announcementSchema)

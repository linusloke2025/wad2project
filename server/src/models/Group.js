import mongoose from 'mongoose'

/**
 * A moving unit within an event.
 *
 * `leadUserId` is deliberately a flag on the member rather than a sixth role: reporting rights
 * follow the assignment, so a lead can report status and GPS for their own group only. Created
 * by a planner, who also chooses the lead.
 */

const groupSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, trim: true },
    leadUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Who is in the group. An embedded list rather than a join collection because a group's
    // membership is read as a whole, never queried from the user's side.
    memberIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
)

groupSchema.index({ eventId: 1 })

export const Group = mongoose.models.Group ?? mongoose.model('Group', groupSchema)

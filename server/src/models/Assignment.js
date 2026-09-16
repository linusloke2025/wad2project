import mongoose from 'mongoose'

/**
 * One slot of a group's itinerary: this group in this zone for this window.
 *
 * A group's assignments form an ordered itinerary, which is what makes a "tight transition" well
 * defined — the gap between consecutive slots is compared against the walk time between their
 * zones. The end-after-start rule is enforced here as well as in the route handler, because
 * importing data by another path should not be able to create an impossible window.
 */

const assignmentSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', required: true },
    start: { type: Date, required: true },
    end: {
      type: Date,
      required: true,
      validate: {
        validator(value) {
          if (!(value instanceof Date) || !(this.start instanceof Date)) return true
          return value.getTime() > this.start.getTime()
        },
        message: 'An assignment must end after it starts',
      },
    },
  },
  { timestamps: true },
)

assignmentSchema.index({ eventId: 1 })
assignmentSchema.index({ groupId: 1, start: 1 })

export const Assignment =
  mongoose.models.Assignment ?? mongoose.model('Assignment', assignmentSchema)

import mongoose from 'mongoose'

import { ACK_STATUSES } from '../domain/announcements.js'

/**
 * A group's response to an announcement: a fixed signal, never text.
 *
 * The enum is imported from the domain rather than duplicated, so a signal the tally logic does
 * not understand cannot be stored. The unique index on (announcement, group) is what makes a
 * changed answer an update rather than a second row — which is why a lead who taps the wrong
 * button can correct it without inflating the counts.
 */

const announcementAckSchema = new mongoose.Schema(
  {
    announcementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    status: { type: String, required: true, enum: ACK_STATUSES },
    at: { type: Date, default: null },
  },
  { timestamps: true },
)

// One live answer per group per announcement.
announcementAckSchema.index({ announcementId: 1, groupId: 1 }, { unique: true })

export const AnnouncementAck =
  mongoose.models.AnnouncementAck ?? mongoose.model('AnnouncementAck', announcementAckSchema)

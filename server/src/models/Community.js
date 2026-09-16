import mongoose from 'mongoose'

/**
 * The tenant. Owns events and memberships; every role is scoped to one community.
 */

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
)

export const Community = mongoose.models.Community ?? mongoose.model('Community', communitySchema)

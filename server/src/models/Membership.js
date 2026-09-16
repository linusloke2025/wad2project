import mongoose from 'mongoose'

import { ROLES } from '../domain/permissions.js'

/**
 * The join between a user and a community, carrying the role they hold *there*.
 *
 * This is why roles are per-community rather than a field on the user: the same person can be a
 * planner in one community and an admin in another. The `role` enum is imported from the RBAC
 * matrix rather than duplicated, so a role the permission system does not know cannot be stored.
 */

const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    role: { type: String, required: true, enum: ROLES },
  },
  { timestamps: true },
)

// One role per person per community.
membershipSchema.index({ userId: 1, communityId: 1 }, { unique: true })

export const Membership =
  mongoose.models.Membership ?? mongoose.model('Membership', membershipSchema)

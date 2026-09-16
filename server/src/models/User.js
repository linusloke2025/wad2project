import mongoose from 'mongoose'

/**
 * A person. Accounts are admin-provisioned (docs/SPEC.md section 5.1) — there is no public
 * sign-up — so a new user starts on a temporary password and must change it before doing
 * anything else.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      // Normalised on write so a login cannot miss on casing or stray whitespace.
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Email address is not valid'],
    },
    name: { type: String, trim: true, default: '' },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: true },
  },
  { timestamps: true },
)

export const User = mongoose.models.User ?? mongoose.model('User', userSchema)

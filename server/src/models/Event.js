import mongoose from 'mongoose'

/**
 * An event within a community.
 *
 * `layoutMode` decides how the plan is drawn and how walk times are obtained:
 *   - 'map'  — zones carry real coordinates, so OneMap routing provides real walk times and the
 *              layout is rendered on an OneMap static map.
 *   - 'plan' — zones are image pixels, so walk times are estimated from the pixel-to-metre
 *              scale and the layout is the uploaded floor plan.
 *
 * `status` is the live window. Live tracking and GPS operate only while `live`, which bounds
 * location collection to event hours — relevant to the retention policy in the spec.
 */

const eventSchema = new mongoose.Schema(
  {
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    name: { type: String, required: true, trim: true },
    start: { type: Date, default: null },
    end: { type: Date, default: null },
    layoutMode: { type: String, enum: ['map', 'plan'], default: 'plan' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    zoom: { type: Number, default: null },
    metresPerPixel: { type: Number, default: 1 },
    status: { type: String, enum: ['draft', 'live', 'ended'], default: 'draft' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
)

export const Event = mongoose.models.Event ?? mongoose.model('Event', eventSchema)

import mongoose from 'mongoose'

/**
 * A shape placed on the layout by the layout designer.
 *
 * `kind` distinguishes what the shape means:
 *   zone      — an area groups occupy (stage, holding area, walkway)
 *   blocked   — an area that must not be used; the conflict engine flags assignments that
 *               occupy it or route through it
 *   obstacle, stairs, lift — informational shapes the planner should account for
 *
 * `polygon` is stored as Mixed rather than `[[Number]]` on purpose. Letting Mongoose cast would
 * turn a malformed shape into a CastError whose message names the cast rather than the rule, and
 * would let a ragged array through in some cases. A hand-written validator states the rule in
 * one place and produces one predictable message.
 */

const SHAPE_KINDS = ['zone', 'blocked', 'obstacle', 'stairs', 'lift']
const MIN_POLYGON_POINTS = 3

export function isDrawablePolygon(polygon) {
  return (
    Array.isArray(polygon) &&
    polygon.length >= MIN_POLYGON_POINTS &&
    polygon.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    )
  )
}

const zoneSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: SHAPE_KINDS, default: 'zone' },
    polygon: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator: isDrawablePolygon,
        message: `polygon must be at least ${MIN_POLYGON_POINTS} [x, y] coordinate pairs`,
      },
    },
  },
  { timestamps: true },
)

zoneSchema.index({ eventId: 1 })

export const Zone = mongoose.models.Zone ?? mongoose.model('Zone', zoneSchema)

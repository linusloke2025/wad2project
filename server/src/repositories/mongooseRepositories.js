/**
 * Mongoose-backed repositories.
 *
 * These implement the same plain-object interface the HTTP tests drive with in-memory fakes, so
 * swapping one for the other is a one-line change in the server entry point.
 *
 * Every method that takes an id guards it first. Mongoose casts an id string before querying, so
 * a malformed id throws a CastError — which would surface as an HTTP 500 instead of the 404 the
 * route promises. Guarding before the query also means those paths never reach the database,
 * which is why they can be tested without a cluster.
 *
 * Documents are serialised through `serialize.js`, so callers get `id` instead of `_id` and ISO
 * strings instead of Date objects, matching what the conflict engine is written against.
 */

import mongoose from 'mongoose'

import { Announcement, AnnouncementAck, Assignment, Community, Event, Group, Membership, StatusUpdate, User, Zone } from '../models/index.js'
import { toDto, toDtoList } from './serialize.js'

/** True only for values Mongoose can cast to an ObjectId. */
function isValidId(value) {
  return typeof value === 'string' && mongoose.isValidObjectId(value)
}

function normaliseEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

export function createMongooseRepositories() {
  return {
    users: {
      async findByEmail(email) {
        const normalised = normaliseEmail(email)
        if (normalised === '') return null
        return toDto(await User.findOne({ email: normalised }))
      },

      async findById(id) {
        if (!isValidId(id)) return null
        return toDto(await User.findById(id))
      },

      async create({ email, name, passwordHash, mustChangePassword = true }) {
        const created = await User.create({ email, name, passwordHash, mustChangePassword })
        return toDto(created)
      },

      async updatePassword(id, { passwordHash, mustChangePassword }) {
        if (!isValidId(id)) return null
        return toDto(
          await User.findByIdAndUpdate(id, { passwordHash, mustChangePassword }, { new: true }),
        )
      },
    },

    memberships: {
      async listByUser(userId) {
        if (!isValidId(userId)) return []
        return toDtoList(await Membership.find({ userId }))
      },

      async find(userId, communityId) {
        if (!isValidId(userId) || !isValidId(communityId)) return null
        return toDto(await Membership.findOne({ userId, communityId }))
      },

      async create({ userId, communityId, role }) {
        return toDto(await Membership.create({ userId, communityId, role }))
      },
    },

    communities: {
      async create({ name, createdBy = null }) {
        return toDto(await Community.create({ name, createdBy }))
      },

      async findById(id) {
        if (!isValidId(id)) return null
        return toDto(await Community.findById(id))
      },
    },

    events: {
      async create(fields) {
        const created = await Event.create({
          ...fields,
          // An absent metresPerPixel must still let the plan scale default, rather than storing null.
          metresPerPixel: fields.metresPerPixel ?? 1,
        })
        return toDto(created)
      },

      async findById(id) {
        if (!isValidId(id)) return null
        return toDto(await Event.findById(id))
      },

      async listByCommunity(communityId) {
        if (!isValidId(communityId)) return []
        return toDtoList(await Event.find({ communityId }).sort({ start: 1 }))
      },

      async updateLayoutImage(eventId, layoutImageId) {
        if (!isValidId(eventId)) return null
        return toDto(await Event.findByIdAndUpdate(eventId, { layoutImageId }, { new: true }))
      },
    },

    /**
     * Floor-plan images, stored in GridFS.
     *
     * GridFS rather than a filesystem path because uploads have to survive a redeploy, and on
     * the ephemeral hosts this app targets a local directory would not. It also keeps the images
     * inside the same backup and quota as everything else.
     */
    layoutImages: {
      bucket() {
        return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'layoutImages' })
      },

      async put({ eventId, buffer, contentType }) {
        const id = new mongoose.Types.ObjectId()
        const bucket = this.bucket()

        await new Promise((resolve, reject) => {
          const stream = bucket.openUploadStreamWithId(id, `${eventId}-layout`, { contentType })
          stream.on('error', reject)
          stream.on('finish', resolve)
          stream.end(buffer)
        })

        return String(id)
      },

      async get(id) {
        if (!isValidId(id)) return null

        const _id = new mongoose.Types.ObjectId(id)
        const bucket = this.bucket()
        const files = await bucket.find({ _id }).toArray()
        if (files.length === 0) return null

        const chunks = []
        await new Promise((resolve, reject) => {
          bucket
            .openDownloadStream(_id)
            .on('data', (chunk) => chunks.push(chunk))
            .on('error', reject)
            .on('end', resolve)
        })

        return {
          buffer: Buffer.concat(chunks),
          contentType: files[0].contentType ?? 'application/octet-stream',
        }
      },
    },

    zones: {
      async create(fields) {
        return toDto(await Zone.create(fields))
      },

      async listByEvent(eventId) {
        if (!isValidId(eventId)) return []
        return toDtoList(await Zone.find({ eventId }))
      },

      async deleteById(id) {
        if (!isValidId(id)) return undefined
        await Zone.findByIdAndDelete(id)
        return undefined
      },
    },

    groups: {
      async create(fields) {
        return toDto(await Group.create(fields))
      },

      async findById(id) {
        if (!isValidId(id)) return null
        return toDto(await Group.findById(id))
      },

      async listByEvent(eventId) {
        if (!isValidId(eventId)) return []
        return toDtoList(await Group.find({ eventId }))
      },
    },

    assignments: {
      async create(fields) {
        return toDto(await Assignment.create(fields))
      },

      async listByEvent(eventId) {
        if (!isValidId(eventId)) return []
        return toDtoList(await Assignment.find({ eventId }).sort({ start: 1 }))
      },
    },

    announcements: {
      async create({ eventId, body, createdBy = null }) {
        return toDto(await Announcement.create({ eventId, body, createdBy }))
      },
      async findById(id) {
        if (!isValidId(id)) return null
        return toDto(await Announcement.findById(id))
      },

      async listByEvent(eventId) {
        if (!isValidId(eventId)) return []
        return toDtoList(await Announcement.find({ eventId }).sort({ createdAt: -1 }))
      },
    },

    announcementAcks: {
      async upsert({ announcementId, groupId, status, at = null }) {
        if (!isValidId(announcementId) || !isValidId(groupId)) return null
        // And upsert, so a lead correcting their answer replaces it rather than being counted
        // twice -- exactly what the unique (announcement, group) index enforces.
        return toDto(
          await AnnouncementAck.findOneAndUpdate(
            { announcementId, groupId },
            { status, at },
            { new: true, upsert: true, setDefaultsOnInsert: true },
          ),
        )
      },

      async listByAnnouncement(announcementId) {
        if (!isValidId(announcementId)) return []
        return toDtoList(await AnnouncementAck.find({ announcementId }))
      },
    },

    statusUpdates: {
      async create({ eventId, groupId, status, at }) {
        return toDto(await StatusUpdate.create({ eventId, groupId, status, at }))
      },

      async listByEvent(eventId) {
        if (!isValidId(eventId)) return []
        // Time order matters: the report derives dwell from consecutive reports.
        return toDtoList(await StatusUpdate.find({ eventId }).sort({ at: 1 }))
      },
    },
  }
}

/**
 * Community membership management.
 *
 * Mass-add is the onboarding path: accounts are provisioned by an admin, never self-registered
 * (docs/SPEC.md section 5.1), so this is how a roster arrives.
 *
 * The spec's failure mode drives the shape of the response. An invalid row is reported per row
 * with its original line number while the valid rows still import, so an admin fixes the file and
 * re-uploads rather than losing the whole batch. The parser is a pure module with its own tests;
 * this route only adds persistence and the identity rules.
 */

import { Router } from 'express'

import { hashPassword } from '../../auth/passwords.js'
import { CsvFormatError, parseUserCsv } from '../../domain/csvImport.js'
import { requireCapability } from '../middleware/requireCapability.js'

export function createMembersRouter({ repositories }) {
  const router = Router()

  router.post('/import', requireCapability('user.massAdd'), async (req, res, next) => {
    try {
      const { csv } = req.body ?? {}

      if (typeof csv !== 'string' || csv.trim() === '') {
        return res.status(400).json({ error: 'CSV content is required' })
      }

      let parsed
      try {
        parsed = parseUserCsv(csv)
      } catch (error) {
        // A header problem invalidates every row, so it is a bad request rather than a row error.
        if (error instanceof CsvFormatError) {
          return res.status(400).json({ error: error.message })
        }
        throw error
      }

      const communityId = req.auth.communityId
      const results = []
      // Row-level rejections from the parser, extended with anything only the database can know.
      const errors = [...parsed.errors]

      for (const row of parsed.valid) {
        const existing = await repositories.users.findByEmail(row.email)

        if (existing) {
          const membership = await repositories.memberships.find(existing.id, communityId)
          if (membership) {
            errors.push({
              line: row.line,
              raw: row.email,
              message: 'Already a member of this community',
            })
            continue
          }

          // A person can belong to several communities, so this adds a membership rather than
          // creating a second account for the same email.
          await repositories.memberships.create({ userId: existing.id, communityId, role: 'user' })
          results.push({ email: row.email, userId: existing.id, created: false })
          continue
        }

        const created = await repositories.users.create({
          email: row.email,
          name: row.name,
          passwordHash: await hashPassword(row.tempPassword),
          // The admin chose this password, so the owner must replace it before doing anything.
          mustChangePassword: true,
        })
        await repositories.memberships.create({ userId: created.id, communityId, role: 'user' })
        results.push({ email: row.email, userId: created.id, created: true })
      }

      return res.status(201).json({ imported: results.length, results, errors })
    } catch (error) {
      return next(error)
    }
  })

  return router
}

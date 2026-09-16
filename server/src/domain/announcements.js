/**
 * Announcement acknowledgement tallies.
 *
 * Announcements are one-way: a planner broadcasts, and group leads answer with a fixed signal.
 * There is deliberately **no free-text field** — a text box would make this chat, and the point
 * is to remove the messy-Telegram problem without rebuilding Telegram inside the app.
 *
 * The tally is what makes the signals worth collecting. "Did every group receive the change?" is
 * the exact gap Telegram leaves, so the most useful output is not the counts but the list of
 * groups that have NOT answered.
 *
 * Three outcomes are kept distinct because collapsing them would hide real problems:
 *   acknowledged  — understood and complying
 *   need_help     — answered, but cannot proceed without assistance
 *   cant_comply   — answered, and will not be able to do it
 *
 * "Answered" is therefore not the same as "acknowledged": a group that needs help has responded
 * but has not confirmed compliance, and a planner must not see a false "everyone is fine".
 *
 * Pure, so no database or socket is needed to verify it.
 */

/** The only three signals a group can send. */
export const ACK_STATUSES = ['acknowledged', 'need_help', 'cant_comply']

/**
 * @param {{groups?: Array<{id: string}>, acknowledgements?: Array<{groupId: string, status: string, at?: string}>}} input
 */
export function summarizeAcknowledgements({ groups = [], acknowledgements = [] } = {}) {
  const groupIds = groups.map((group) => group.id)
  const knownGroupIds = new Set(groupIds)

  // Keep only the most recent response per group, so a lead changing their mind replaces the
  // earlier answer rather than being counted twice. ISO-8601 strings compare correctly as text
  // when they share an offset, which is how the app stores them.
  const latestByGroup = new Map()
  for (const entry of acknowledgements) {
    // A stale row from a deleted group must not inflate the counts.
    if (!knownGroupIds.has(entry.groupId)) continue

    const existing = latestByGroup.get(entry.groupId)
    if (!existing || String(entry.at ?? '') >= String(existing.at ?? '')) {
      latestByGroup.set(entry.groupId, entry)
    }
  }

  const acknowledgedGroupIds = []
  const needHelpGroupIds = []
  const cantComplyGroupIds = []
  const awaitingResponseGroupIds = []
  const notAcknowledgedGroupIds = []

  for (const groupId of groupIds) {
    const entry = latestByGroup.get(groupId)

    if (!entry) {
      awaitingResponseGroupIds.push(groupId)
      notAcknowledgedGroupIds.push(groupId)
      continue
    }

    if (entry.status === 'acknowledged') acknowledgedGroupIds.push(groupId)
    else if (entry.status === 'need_help') needHelpGroupIds.push(groupId)
    else if (entry.status === 'cant_comply') cantComplyGroupIds.push(groupId)

    if (entry.status !== 'acknowledged') notAcknowledgedGroupIds.push(groupId)
  }

  return {
    counts: {
      acknowledged: acknowledgedGroupIds.length,
      need_help: needHelpGroupIds.length,
      cant_comply: cantComplyGroupIds.length,
    },
    acknowledgedGroupIds,
    needHelpGroupIds,
    cantComplyGroupIds,
    // Nobody has answered at all.
    awaitingResponseGroupIds,
    // Answered but not complying, or not answered yet.
    notAcknowledgedGroupIds,
    totalGroups: groupIds.length,
    // An event with no groups is vacuously complete, not perpetually pending.
    allAcknowledged: notAcknowledgedGroupIds.length === 0,
  }
}

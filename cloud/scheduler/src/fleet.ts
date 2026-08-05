// The fleet-health read, which is the only place one class of failure is visible.
//
// `CONTRACTS.md` § 10 hole 8 and § 11 item 10 both name it: if TCC binds a Full Disk
// Access grant to a versioned bundle path, **an auto-update drops the grant for every Mac
// in the fleet on the same day.** From any single user's row that is indistinguishable
// from one person closing their laptop. It is visible **only in aggregate**, and the
// server is the only place the correlation can happen.
//
// The Mac half is built — `Heartbeat.swift` and its stall alarm. This is the half that
// was missing.
//
// The shape that matters is the RATIO, not the count. Eight of ten devices quiet on the
// same day is a fleet event; two of ten is Tuesday, and an alarm that fires on two
// teaches people to ignore it — which is how the real one gets waved through.

import { getPool, type Queryable } from "../../db/src/pool.js";

/** A device counts as quiet after this long without a heartbeat. */
export const QUIET_AFTER_HOURS = 36;

/**
 * Below this share of the fleet, quiet devices are just people with closed laptops.
 *
 * Half is deliberately far above any plausible normal: a real fleet-wide TCC event takes
 * out everyone on one app version at once, so the signal it produces is enormous. A
 * threshold tuned tight enough to catch a subtle drift would fire every weekend.
 */
export const FLEET_ALARM_SHARE = 0.5;

/** Below this many devices, a share is arithmetic rather than evidence. */
export const FLEET_ALARM_MINIMUM_DEVICES = 5;

export type FleetHealth = {
  as_of: string;
  devices: number;
  quiet: number;
  quiet_share: number;
  /**
   * Reporting, and has never produced a digest. AMENDMENT-003's bucket.
   *
   * **Not healthy and not quiet, which is the whole point.** A Mac with Full Disk Access
   * that heartbeats every hour and has never synced is a BROKEN SYNC — a different
   * failure from a Mac nobody has opened, with a different fix. Before `digest_as_of`
   * could be null the state was unrepresentable, so these devices counted as healthy and
   * the most diagnostic thing the fleet knows was invisible.
   */
  never_synced: number;
  never_synced_share: number;
  alarm: boolean;
  /** The second alarm: a fleet-wide share reporting and producing nothing. */
  sync_alarm: boolean;
  /**
   * Quiet share per `app_version`.
   *
   * The version is what makes the alarm actionable. `bundle_path_stable` — the Mac's own
   * read of WHY — does not cross the wire (see the heartbeat disagreement above in
   * NOTES.md), but `app_version` does, and "every device on 1.4.0 went quiet on Tuesday"
   * names the release without it.
   */
  by_app_version: Array<{
    app_version: string | null; devices: number; quiet: number; never_synced: number;
  }>;
};

/**
 * One query over `devices`, no user content, no join to anybody's messages.
 *
 * Unscoped by necessity and by nature: the whole point is the correlation ACROSS users,
 * which is the one aggregate the architecture asks for and the one thing a per-user
 * scope cannot express. It reads two columns — a timestamp and a version string — and
 * cannot reach a handle, a contact or a message from here.
 */
export async function fleetHeartbeatHealth(
  options: {
    now?: Date;
    quietAfterHours?: number;
    alarmShare?: number;
    minimumDevices?: number;
    db?: Queryable;
  } = {},
): Promise<FleetHealth> {
  const now = options.now ?? new Date();
  const quietAfterHours = options.quietAfterHours ?? QUIET_AFTER_HOURS;
  const alarmShare = options.alarmShare ?? FLEET_ALARM_SHARE;
  const minimumDevices = options.minimumDevices ?? FLEET_ALARM_MINIMUM_DEVICES;
  const db = options.db ?? getPool();

  const cutoff = new Date(now.getTime() - quietAfterHours * 3_600_000);

  // A device that has NEVER reported counts as quiet. It is a Mac that paired and then
  // never came back, which is the same fleet symptom and arguably the worst version of
  // it — the grant may never have worked at all.
  const res = await db.query<{
    app_version: string | null; devices: string; quiet: string; never_synced: string;
  }>(
    `select app_version,
            count(*)::text as devices,
            count(*) filter (
              where last_heartbeat_at is null or last_heartbeat_at < $1
            )::text as quiet,
            -- REPORTING and never synced. The liveness clause is repeated on purpose:
            -- a device that is quiet AND has never synced is counted as quiet, because
            -- "we have not heard from it" is the more fundamental fact and double
            -- counting would make the two shares add up to more than the fleet.
            count(*) filter (
              where last_heartbeat_at is not null
                and last_heartbeat_at >= $1
                and digest_as_of is null
            )::text as never_synced
       from devices
      group by app_version
      order by app_version nulls last`,
    [cutoff.toISOString()],
  );

  const byVersion = res.rows.map((r) => ({
    app_version: r.app_version,
    devices: Number(r.devices),
    quiet: Number(r.quiet),
    never_synced: Number(r.never_synced),
  }));
  const devices = byVersion.reduce((n, r) => n + r.devices, 0);
  const quiet = byVersion.reduce((n, r) => n + r.quiet, 0);
  const neverSynced = byVersion.reduce((n, r) => n + r.never_synced, 0);
  const quietShare = devices === 0 ? 0 : quiet / devices;
  const neverSyncedShare = devices === 0 ? 0 : neverSynced / devices;

  return {
    as_of: now.toISOString(),
    devices,
    quiet,
    quiet_share: quietShare,
    never_synced: neverSynced,
    never_synced_share: neverSyncedShare,
    alarm: devices >= minimumDevices && quietShare >= alarmShare,
    sync_alarm: devices >= minimumDevices && neverSyncedShare >= alarmShare,
    by_app_version: byVersion,
  };
}

/** The log line. Structured JSON, no user content — `CONTRACTS.md` § 6. */
export function fleetHealthEvent(health: FleetHealth): Record<string, unknown> {
  // Two alarms, two causes, two fixes. Collapsing them into one "fleet unhealthy" line
  // would send somebody to look at TCC grants when the grants are fine and the sync is
  // broken, which is the failure this bucket exists to prevent.
  const msg = health.alarm
    ? "fleet.quiet_alarm"
    : health.sync_alarm ? "fleet.never_synced_alarm" : "fleet.health";
  return {
    msg,
    level: health.alarm || health.sync_alarm ? "error" : "info",
    devices: health.devices,
    quiet: health.quiet,
    quiet_share: Number(health.quiet_share.toFixed(3)),
    never_synced: health.never_synced,
    never_synced_share: Number(health.never_synced_share.toFixed(3)),
    by_app_version: health.by_app_version,
    as_of: health.as_of,
    ...(health.alarm
      ? {
          consequence:
            "a fleet-wide share of Macs stopped reporting. Check whether an auto-update "
            + "changed the bundle path and dropped Full Disk Access for everyone on that "
            + "version at once.",
        }
      : {}),
    ...(health.sync_alarm
      ? {
          consequence:
            "a fleet-wide share of Macs are REPORTING and have never produced a digest. "
            + "The grant is fine and the sync is not: look at the reader, the mirror, or "
            + "a release that broke it. These devices are not quiet and must not be "
            + "counted as healthy.",
        }
      : {}),
  };
}

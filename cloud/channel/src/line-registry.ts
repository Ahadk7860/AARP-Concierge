// Line assignment: who is on which line, and who just lost their thread.
//
// A user's line changing is a RETENTION EVENT DRESSED UP AS AN INFRASTRUCTURE EVENT.
// Their conversation history is gone from their phone and Boi arrives as an unknown
// sender. And because lines are shared, one ban takes out every user on that line at the
// same moment — so "who is affected" has to be answerable instantly, not reconstructed
// from logs while people are already not getting their brief.
//
// Everything here is in-process. Track D owns the database; persisting this is theirs,
// and `LineRegistrySnapshot` is the shape to persist. Provider-neutral: nothing in this
// file knows who carries the messages.

export type LineId = string;
export type LineStatus = "up" | "degraded" | "banned";

export type LineDefinition = {
  line_id: LineId;
  handle: string;
};

/**
 * Config. Every value here stands in for an unanswered sales-call question, which is the
 * whole point of the file: when the answers arrive they land in `.env`, not in a diff.
 */
export type LineRegistryConfig = {
  lines: LineDefinition[];
  /**
   * CONTRACTS.md § 11 item 7 — tenants per line is unknown and we assume shared.
   *
   * Deliberately low. **Cost is linear in lines; ban risk is super-linear in users per
   * line** — one banned line with 500 users on it is a different kind of incident from
   * five banned lines with 5 users each, and the second is survivable.
   */
  usersPerLine: number;
  /** § 11 item 5 — is a line sticky indefinitely? Assume not, and treat any change as a
   *  migration rather than an infrastructure detail. */
  sticky: boolean;
  /** § 11 item 6 — are we told before a number rotates? Assume no, so rotation is
   *  detected reactively and always carries the re-introduction. */
  assumeRotationNotice: boolean;
  /** § 11 item 4 — does the 99.95% SLA cover a line-level ban? Assume it does not, so a
   *  ban migrates users off immediately rather than waiting for the provider. */
  banCoveredBySla: boolean;
};

export const DEFAULT_LINE_CONFIG: Omit<LineRegistryConfig, "lines"> = {
  usersPerLine: 5,
  sticky: true,
  assumeRotationNotice: false,
  banCoveredBySla: false,
};

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid ${label}: ${raw}`);
  return n;
}

function parseBool(raw: string | undefined, fallback: boolean, label: string): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new Error(`invalid ${label}: ${raw} (expected 1/0/true/false)`);
}

/** `LINE_POOL="line_a1=+15550100123,line_a2=+15550100124"`. */
export function parseLinePool(raw: string | undefined): LineDefinition[] {
  if (raw === undefined || raw.trim() === "") return [];
  const lines: LineDefinition[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const [id, handle] = trimmed.split("=");
    if (id === undefined || handle === undefined || id.trim() === "" || handle.trim() === "") {
      throw new Error(`invalid LINE_POOL entry: ${trimmed} (expected line_id=handle)`);
    }
    lines.push({ line_id: id.trim(), handle: handle.trim() });
  }
  return lines;
}

export function loadLineRegistryConfig(env: NodeJS.ProcessEnv = process.env): LineRegistryConfig {
  return {
    lines: parseLinePool(env.LINE_POOL),
    usersPerLine: parsePositiveInt(env.LINE_USERS_PER_LINE, DEFAULT_LINE_CONFIG.usersPerLine, "LINE_USERS_PER_LINE"),
    sticky: parseBool(env.LINE_STICKY, DEFAULT_LINE_CONFIG.sticky, "LINE_STICKY"),
    assumeRotationNotice: parseBool(
      env.LINE_ASSUME_ROTATION_NOTICE,
      DEFAULT_LINE_CONFIG.assumeRotationNotice,
      "LINE_ASSUME_ROTATION_NOTICE",
    ),
    banCoveredBySla: parseBool(env.LINE_BAN_COVERED_BY_SLA, DEFAULT_LINE_CONFIG.banCoveredBySla, "LINE_BAN_COVERED_BY_SLA"),
  };
}

export class NoLineCapacityError extends Error {
  constructor(usersPerLine: number, lineCount: number) {
    super(`no line capacity: ${lineCount} line(s) at ${usersPerLine} users each are full`);
    this.name = "NoLineCapacityError";
  }
}

/** A user moving lines. Returned rather than swallowed, because it is the moment the
 *  product has to say something to a person. */
export type Migration = {
  user_id: string;
  from: LineId | null;
  to: LineId;
  at: string;
  reason: "initial" | "rotation" | "health";
};

export type LineMetric = {
  line_id: LineId;
  handle: string;
  status: LineStatus;
  user_count: number;
  capacity: number;
  /** True when this line is at or over its configured tenancy. */
  full: boolean;
};

export type LineRegistrySnapshot = {
  assignments: { user_id: string; line_id: LineId; since: string }[];
  introduced: { user_id: string; line_id: LineId }[];
  statuses: { line_id: LineId; status: LineStatus }[];
};

export class LineRegistry {
  private readonly config: LineRegistryConfig;
  private readonly now: () => Date;
  private readonly assignments = new Map<string, { lineId: LineId; since: string }>();
  private readonly members = new Map<LineId, Set<string>>();
  private readonly statuses = new Map<LineId, LineStatus>();
  /** (user, line) pairs that have already had the "this is Boi, new number" message. */
  private readonly introduced = new Set<string>();

  constructor(config: LineRegistryConfig, now: () => Date = () => new Date()) {
    this.config = config;
    this.now = now;
    for (const line of config.lines) {
      this.members.set(line.line_id, new Set());
      this.statuses.set(line.line_id, "up");
    }
  }

  get usersPerLine(): number {
    return this.config.usersPerLine;
  }

  /**
   * Sticky by default: a user keeps their line. Returns the existing assignment
   * unchanged, so calling this on every send is safe and is how stickiness is enforced
   * rather than merely intended.
   */
  assign(userId: string): LineId {
    const existing = this.assignments.get(userId);
    if (existing !== undefined && this.config.sticky) return existing.lineId;
    if (existing !== undefined) return existing.lineId;
    return this.place(userId, "initial").to;
  }

  lineFor(userId: string): LineId | null {
    return this.assignments.get(userId)?.lineId ?? null;
  }

  /**
   * THE BLAST-RADIUS QUERY. Given a line, every user who just lost their thread — one
   * call, no scan, no log archaeology. This is the question you need answered in the
   * first minute of a ban, and needing to write a script to answer it means answering it
   * an hour late.
   */
  usersOn(lineId: LineId): string[] {
    return [...(this.members.get(lineId) ?? [])].sort();
  }

  /** Moves a user to a different healthy line and marks them as needing a
   *  re-introduction. A migration, not a reassignment. */
  migrate(userId: string, reason: Migration["reason"]): Migration {
    return this.place(userId, reason);
  }

  private place(userId: string, reason: Migration["reason"]): Migration {
    const previous = this.assignments.get(userId)?.lineId ?? null;
    const target = this.nextAvailableLine(previous);
    if (target === null) throw new NoLineCapacityError(this.config.usersPerLine, this.config.lines.length);

    if (previous !== null) this.members.get(previous)?.delete(userId);
    const at = this.now().toISOString();
    this.assignments.set(userId, { lineId: target, since: at });
    let set = this.members.get(target);
    if (set === undefined) {
      set = new Set();
      this.members.set(target, set);
    }
    set.add(userId);

    // A FIRST-EVER assignment is not a rotation, and must not produce the "new number"
    // preamble. Telling a brand-new user "same conversation, new bubbles" is a false
    // statement about their own history in the product's voice — degrade-never-fabricate,
    // crossed — and it would land on top of Track D's genuine first-contact message.
    // Marking them introduced here is what makes `needsIntroduction` mean "your number
    // changed", not "we have not met".
    if (reason === "initial") this.markIntroduced(userId, target);

    return { user_id: userId, from: previous, to: target, at, reason };
  }

  /** Fills lines in order up to the configured tenancy, skipping unhealthy ones and the
   *  line being migrated away from. */
  private nextAvailableLine(exclude: LineId | null): LineId | null {
    for (const line of this.config.lines) {
      if (line.line_id === exclude) continue;
      if (this.statuses.get(line.line_id) === "banned") continue;
      const count = this.members.get(line.line_id)?.size ?? 0;
      if (count < this.config.usersPerLine) return line.line_id;
    }
    return null;
  }

  setStatus(lineId: LineId, status: LineStatus): void {
    this.statuses.set(lineId, status);
  }

  statusOf(lineId: LineId): LineStatus {
    return this.statuses.get(lineId) ?? "up";
  }

  handleOf(lineId: LineId): string | null {
    return this.config.lines.find((l) => l.line_id === lineId)?.handle ?? null;
  }

  /**
   * True when this user needs telling that their NUMBER CHANGED — never on first contact.
   *
   * The product rule it serves: arriving from a new number and resuming mid-conversation
   * reads as a stranger who somehow knows you. Leading with "this is Boi, new number" is
   * the difference between a migration and a cold, slightly alarming contact.
   *
   * But the inverse is just as wrong. On a first-ever assignment there was no previous
   * conversation and no previous number, so the preamble would be a fabrication — and
   * Track D already sends a real first-contact message with a contact card. Initial
   * placement therefore marks the pair introduced immediately; see `place()`.
   */
  needsIntroduction(userId: string, lineId: LineId): boolean {
    return !this.introduced.has(`${userId} ${lineId}`);
  }

  markIntroduced(userId: string, lineId: LineId): void {
    this.introduced.add(`${userId} ${lineId}`);
  }

  /** Users-per-line and current health for every line, so a ban's blast radius is
   *  visible immediately rather than computed during the incident. */
  metrics(): LineMetric[] {
    return this.config.lines.map((line) => {
      const count = this.members.get(line.line_id)?.size ?? 0;
      return {
        line_id: line.line_id,
        handle: line.handle,
        status: this.statusOf(line.line_id),
        user_count: count,
        capacity: this.config.usersPerLine,
        full: count >= this.config.usersPerLine,
      };
    });
  }

  /** The shape Track D persists. In-process state is correct for this round; losing it
   *  on restart would re-introduce every user, which is a user-visible bug. */
  snapshot(): LineRegistrySnapshot {
    return {
      assignments: [...this.assignments.entries()]
        .map(([user_id, a]) => ({ user_id, line_id: a.lineId, since: a.since }))
        .sort((a, b) => a.user_id.localeCompare(b.user_id)),
      introduced: [...this.introduced].map((key) => {
        const [user_id = "", line_id = ""] = key.split(" ");
        return { user_id, line_id };
      }),
      statuses: [...this.statuses.entries()].map(([line_id, status]) => ({ line_id, status })),
    };
  }

  restore(snapshot: LineRegistrySnapshot): void {
    for (const { line_id, status } of snapshot.statuses) this.statuses.set(line_id, status);
    for (const { user_id, line_id, since } of snapshot.assignments) {
      this.assignments.set(user_id, { lineId: line_id, since });
      let set = this.members.get(line_id);
      if (set === undefined) {
        set = new Set();
        this.members.set(line_id, set);
      }
      set.add(user_id);
    }
    for (const { user_id, line_id } of snapshot.introduced) this.markIntroduced(user_id, line_id);
  }
}

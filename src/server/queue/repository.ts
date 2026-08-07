import { eq } from "drizzle-orm"

import type {
  AdmissionInput,
  ClaimInput,
  FieldCipher,
  JobRecord,
  RecordAttemptInput,
} from "../db/contracts"
import { EpochMillisecondsSchema, type JobId } from "../db/ids"
import { jobs } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import { admit } from "./admission"
import { finalizeSuccess, recordFailure } from "./attempt-finish"
import { prepareAttempt } from "./attempt-start"
import { claim, renewLease } from "./claims"
import type {
  AdmissionResult,
  ClaimCommand,
  ClaimResult,
  FinalizeSuccessCommand,
  PrepareAttemptCommand,
  PrepareAttemptResult,
  QueueClock,
  QueueRepository,
  RecordFailureCommand,
  RecordFailureResult,
  RenewLeaseCommand,
  SingleAdmissionCommand,
} from "./contracts"
import { admitLegacy, claimLegacy, recordLegacyAttempt } from "./legacy"
import { mapJob } from "./persistence"

const SYSTEM_CLOCK: QueueClock = {
  now: () => EpochMillisecondsSchema.parse(Date.now()),
}

export class DrizzleQueueRepository implements QueueRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
    private readonly clock: QueueClock = SYSTEM_CLOCK,
  ) {}

  admitSingle(input: AdmissionInput): JobRecord {
    return admitLegacy(this.database, this.cipher, input)
  }

  admit(input: SingleAdmissionCommand): AdmissionResult {
    return admit(this.database, this.cipher, this.clock, input)
  }

  claimNext(input: ClaimInput): JobRecord | null {
    return claimLegacy(this.database, this.cipher, input)
  }

  claim(input: ClaimCommand): ClaimResult {
    return claim(this.database, this.cipher, this.clock, input)
  }

  prepareAttempt(input: PrepareAttemptCommand): PrepareAttemptResult {
    return prepareAttempt(this.database, this.clock, input)
  }

  renewLease(input: RenewLeaseCommand): boolean {
    return renewLease(this.database, this.clock, input)
  }

  recordFailure(input: RecordFailureCommand): RecordFailureResult {
    return recordFailure(this.database, this.clock, input)
  }

  finalizeSuccess(input: FinalizeSuccessCommand): boolean {
    return finalizeSuccess(this.database, this.clock, input)
  }

  findJob(jobId: JobId): JobRecord | null {
    const row = this.database.select().from(jobs).where(eq(jobs.id, jobId)).get()
    return row === undefined ? null : mapJob(row, this.cipher)
  }

  recordAttempt(input: RecordAttemptInput): void {
    recordLegacyAttempt(this.database, input)
  }
}

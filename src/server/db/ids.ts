import { z } from "zod"

export const AttemptIdSchema = z.string().uuid().brand("AttemptId")
export const BatchIdSchema = z.string().uuid().brand("BatchId")
export const BotIdSchema = z.string().uuid().brand("BotId")
export const BotPublicIdSchema = z.string().uuid().brand("BotPublicId")
export const ContextIdSchema = z.string().uuid().brand("ContextId")
export const EpochMillisecondsSchema = z.number().int().nonnegative().brand("EpochMilliseconds")
export const InvocationIdSchema = z.string().uuid().brand("InvocationId")
export const JobIdSchema = z.string().uuid().brand("JobId")

export type AttemptId = z.infer<typeof AttemptIdSchema>
export type BatchId = z.infer<typeof BatchIdSchema>
export type BotId = z.infer<typeof BotIdSchema>
export type BotPublicId = z.infer<typeof BotPublicIdSchema>
export type ContextId = z.infer<typeof ContextIdSchema>
export type EpochMilliseconds = z.infer<typeof EpochMillisecondsSchema>
export type InvocationId = z.infer<typeof InvocationIdSchema>
export type JobId = z.infer<typeof JobIdSchema>

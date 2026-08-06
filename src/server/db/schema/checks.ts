import { sql } from "drizzle-orm"
import { type AnySQLiteColumn, type CheckBuilder, check } from "drizzle-orm/sqlite-core"

export function uuidV4Check(name: string, column: AnySQLiteColumn): CheckBuilder {
  return check(
    name,
    sql`length(${column}) = 36
      AND substr(${column}, 9, 1) = '-'
      AND substr(${column}, 14, 1) = '-'
      AND substr(${column}, 15, 1) = '4'
      AND substr(${column}, 19, 1) = '-'
      AND substr(${column}, 20, 1) IN ('8', '9', 'a', 'b')
      AND substr(${column}, 24, 1) = '-'
      AND ${column} = lower(${column})
      AND length(replace(${column}, '-', '')) = 32
      AND ${column} NOT GLOB '*[^0-9a-f-]*'`,
  )
}

export function sha256Check(name: string, column: AnySQLiteColumn): CheckBuilder {
  return check(name, sql`length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)
}

export function encryptedEnvelopeCheck(name: string, column: AnySQLiteColumn): CheckBuilder {
  return check(name, sql`${column} LIKE 'v1.%'`)
}

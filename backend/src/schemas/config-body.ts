/** The task configs a run is driven from. Ported from datatype/ (ADR 0009, phase 5).
 *
 *  These validate a config body on the way in and are never used to reshape it: the route stores
 *  the body the owner sent, exactly as sent. Pydantic ignores unknown keys rather than rejecting
 *  them, and Zod strips them, so parsing the payload and then storing the PARSED value would
 *  quietly drop fields the owner wrote. Validation is a gate here, not a transform.
 */
import { z } from "zod";

const GmailConfig = z.object({
  subject: z.string(),
  from_address: z.email(),
  to_address: z.array(z.email()),
});

const FileConfig = z.object({ file_path: z.string() });

/** The one model in the Python that forbids extra keys (`extra="forbid"`), because a typo here
 *  means a notification that silently never goes anywhere. */
const NotificationConfig = z
  .object({ gmail: GmailConfig.nullish(), file: FileConfig.nullish() })
  .strict();

const CodeInformation = z.object({ type: z.string(), name: z.string(), market: z.string() });

const Option = z.object({
  type: z.enum(["CALL", "PUT"]),
  direction: z.enum(["long", "short"]),
  strike_price: z.number(),
});

const OptionHolding = z.object({
  strategy: z.string(),
  strike_date: z.string(),
  volume: z.int(),
  entry_price: z.number(),
  warning_threshold: z.object({ delta: z.number() }),
  options: z.array(Option),
});

const OptionStrategy = z.object({
  strategy: z.string(),
  expiry_date_distance: z.object({ min: z.int(), max: z.int() }),
  options: z.array(
    z.object({
      option_type: z.enum(["CALL", "PUT"]),
      filter: z.object({ delta_min: z.number(), delta_max: z.number() }),
      stride: z.int(),
    }),
  ),
});

export const OptionHoldingsConfig = z.object({
  notification: NotificationConfig,
  code_information: CodeInformation,
  option_holdings: z.array(OptionHolding),
});

export const OptionStrategiesConfig = z.object({
  notification: NotificationConfig,
  code_information: CodeInformation,
  option_strategy: OptionStrategy,
});

export const TASK_TYPES = ["strategy", "holdings"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

const CONFIG_SCHEMAS = {
  strategy: OptionStrategiesConfig,
  holdings: OptionHoldingsConfig,
} as const satisfies Record<TaskType, z.ZodType>;

/** Why this body is not a valid config of this type, or null if it is.
 *
 *  UNREACHABLE since #118 removed the /configs routes, and so is everything above it bar
 *  TASK_TYPES and TaskType, which scheduler.ts and ports.ts still import. Left in place rather
 *  than gutted: phase 10 (2026-11-02) removes the run pipeline whole, and this file describes the
 *  Python config format it describes — two edits to the same file for seventeen days.
 *
 *  The consequence to know, since this was the only validation `configs` ever had: the single
 *  remaining way to write one is raw SQL, so a malformed body is no longer refused at the write
 *  and fails inside the worker's subprocess instead, in the background. */
export function configBodyError(taskType: TaskType, body: unknown): string | null {
  const result = CONFIG_SCHEMAS[taskType].safeParse(body);
  return result.success ? null : z.prettifyError(result.error);
}

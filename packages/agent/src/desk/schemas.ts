// Input contracts shared by the LLM tools, the MCP server and the HTTP API.
import type { Profile } from "@slipway/core";
import { z } from "zod";

export const SESSIONS = ["pre_market", "regular", "after_hours", "overnight", "weekend"] as const;

export const SymbolSchema = z
  .string()
  .regex(/^\s*[A-Za-z]{1,10}\s*$/, "an underlying ticker like NVDA")
  .describe("Underlying US stock ticker, e.g. NVDA (not RNVDAUSDT)");

/** Underlyings recorded by the Slipway tape. */
export const UNIVERSE = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "AMD",
  "MU",
  "INTC",
  "MSTR",
  "COIN",
  "CRCL",
  "HOOD",
  "PLTR",
  "SPY",
  "QQQ",
  "SOXL",
] as const;

/** "rnvdausdt" / "NVDAUSDT" / " nvda " -> "NVDA"; the R prefix is only stripped when that names a known underlying. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!s.endsWith("USDT")) return s;
  const base = s.slice(0, -4);
  return base.startsWith("R") && (UNIVERSE as readonly string[]).includes(base.slice(1))
    ? base.slice(1)
    : base;
}

export const VenueSchema = z
  .enum(["rtoken", "perp"])
  .describe("rtoken = Bitget spot tokenized stock R{SYM}USDT; perp = Bitget USDT-M stock perpetual");

export const UrgencySchema = z.enum(["patient", "normal", "urgent"]);

export const IntentFields = {
  symbol: SymbolSchema,
  side: z.enum(["buy", "sell"]),
  notionalUsd: z.number().positive().max(50_000_000).optional().describe("Order size in USD"),
  qty: z.number().positive().max(10_000_000).optional().describe("Order size in shares"),
  deadline: z
    .string()
    .max(40)
    .optional()
    .describe(
      'When the order must be complete, as the trader said it: "before thursday", "by friday", "thursday 16:00", "today", "tomorrow", "before the open", "in 2h", or "YYYY-MM-DD HH:mm" (New York time)',
    ),
  holdHorizonHours: z
    .number()
    .positive()
    .max(24 * 365)
    .optional()
    .describe("How long the position will be held, in hours (enables perp-hold pricing)"),
  venues: z.array(VenueSchema).min(1).max(2).optional().describe('Restrict venues; "no perps" = ["rtoken"]'),
  urgency: UrgencySchema.optional().describe("Per-order override of the profile urgency"),
};

const oneSize = (i: { notionalUsd?: number | undefined; qty?: number | undefined }) =>
  (i.notionalUsd === undefined) !== (i.qty === undefined);
const ONE_SIZE = { message: "give exactly one of notionalUsd or qty" };

export const IntentSchema = z.object(IntentFields).refine(oneSize, ONE_SIZE);

export type IntentInput = z.input<typeof IntentSchema>;
export type Intent = z.output<typeof IntentSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(1).max(40),
  urgency: UrgencySchema,
  costCapBps: z.number().positive().max(1_000),
  maxParticipation: z.number().positive().max(1),
  allowPerp: z.boolean(),
  maxLeverage: z.number().min(0).max(10),
  avoidSessions: z.array(z.enum([...SESSIONS, "closed"])),
  avoidEvents: z.boolean(),
  feeOverride: z
    .object({
      rtoken: z.object({ maker: z.number(), taker: z.number() }).optional(),
      perp: z.object({ maker: z.number(), taker: z.number() }).optional(),
    })
    .optional(),
}) satisfies z.ZodType<Profile>;

export const ProfilePatchSchema = ProfileSchema.omit({ name: true, feeOverride: true }).partial();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export const DEFAULT_PROFILE: Profile = {
  name: "default",
  urgency: "normal",
  costCapBps: 25,
  maxParticipation: 0.1,
  allowPerp: true,
  maxLeverage: 1,
  avoidSessions: [],
  avoidEvents: true,
};

export const PROFILE_PRESETS: Record<string, Profile> = {
  default: DEFAULT_PROFILE,
  patient: {
    ...DEFAULT_PROFILE,
    name: "patient",
    urgency: "patient",
    costCapBps: 15,
    maxParticipation: 0.05,
  },
  urgent: { ...DEFAULT_PROFILE, name: "urgent", urgency: "urgent", costCapBps: 40, maxParticipation: 0.2 },
  spot_only: { ...DEFAULT_PROFILE, name: "spot_only", allowPerp: false },
};

export const StrategyIdSchema = z
  .string()
  .min(1)
  .max(80)
  .describe('A strategy id from price_options, or "best", "baseline", "best:<family>"');

export const PlanInputSchema = z
  .object({ ...IntentFields, strategyId: StrategyIdSchema })
  .refine(oneSize, ONE_SIZE);

export const PlanRequestSchema = z.object({
  intent: IntentSchema,
  profile: ProfileSchema.optional(),
  strategyId: StrategyIdSchema,
});

export const OptionsRequestSchema = z.object({ intent: IntentSchema, profile: ProfileSchema.optional() });

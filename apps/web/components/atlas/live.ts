// Live integrity check shown on the atlas: Bitget's Reality session-state labels against New York's actual clock.

export interface RealityCheck {
  ok: boolean;
  label: string | null;
  zones: string[];
  nyZone: string;
  mismatch: boolean;
  fetchedAt: number;
  error?: string;
  url: string;
}

const URL_STATES = "https://api.bitget.com/api/v3/reality/market/states";

export async function realityCheck(): Promise<RealityCheck> {
  const nyZone =
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "?";
  const fetchedAt = Date.now();
  try {
    const res = await fetch(URL_STATES, { next: { revalidate: 300 } });
    if (!res.ok)
      return {
        ok: false,
        label: null,
        zones: [],
        nyZone,
        mismatch: false,
        fetchedAt,
        error: `HTTP ${res.status}`,
        url: URL_STATES,
      };
    const body = (await res.json()) as {
      data?: { daylightType?: string; stateList?: { timeZone?: string }[] };
    };
    const label = body.data?.daylightType ?? null;
    const zones = [...new Set((body.data?.stateList ?? []).map((s) => s.timeZone ?? "").filter(Boolean))];
    const labelSaysDst = label?.toLowerCase() === "daylight" || zones.includes("EDT");
    const dst = nyZone === "EDT";
    return {
      ok: true,
      label,
      zones,
      nyZone,
      mismatch: label !== null && dst !== labelSaysDst,
      fetchedAt,
      url: URL_STATES,
    };
  } catch (e) {
    return {
      ok: false,
      label: null,
      zones: [],
      nyZone,
      mismatch: false,
      fetchedAt,
      error: e instanceof Error ? e.message : String(e),
      url: URL_STATES,
    };
  }
}

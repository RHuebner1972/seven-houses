import type { Page, Request, Route } from "@playwright/test";

/**
 * In-process stand-in for the Seventh House API, installed with `page.route`. Every
 * endpoint of the contract (plan: Global Constraints) is served from in-memory state so
 * the specs are deterministic and spend nothing. Streams are fulfilled whole: Playwright's
 * `route.fulfill` cannot trickle bytes over time, so the `cards`/`delta`/`done` frames
 * arrive in one body — the UI still receives them in order through the SSE parser.
 */

export const API_ORIGIN = "http://api.test";

// ---- fixtures ---------------------------------------------------------------

type Position = { key: string; name: string; meaning: string };
type Spread = { type: string; name: string; credits: number; positions: Position[] };
type DrawnCard = { position: string; card_id: string; reversed: boolean };

const pos = (key: string, name: string): Position => ({ key, name, meaning: `${name} position` });

export const SPREADS: Spread[] = [
  { type: "daily", name: "Card of the Day", credits: 0, positions: [pos("card", "Card of the Day")] },
  {
    type: "three_card",
    name: "Three Card",
    credits: 1,
    positions: [pos("past", "Past"), pos("present", "Present"), pos("future", "Future")],
  },
  {
    type: "celtic_cross",
    name: "Celtic Cross",
    credits: 3,
    positions: [
      pos("present", "Present"),
      pos("challenge", "Challenge"),
      pos("past", "Past"),
      pos("future", "Future"),
      pos("above", "Above"),
      pos("below", "Below"),
      pos("advice", "Advice"),
      pos("external", "External Influences"),
      pos("hopes_fears", "Hopes and Fears"),
      pos("outcome", "Outcome"),
    ],
  },
];

export const CELTIC_POSITION_NAMES = SPREADS[2].positions.map((p) => p.name);

const CARD_NAMES: Record<string, string> = {
  "major-00-fool": "The Fool",
  "major-01-magician": "The Magician",
  "major-09-hermit": "The Hermit",
  "major-17-star": "The Star",
  "cups-02": "Two of Cups",
  "wands-08": "Eight of Wands",
  "swords-03": "Three of Swords",
  "pentacles-10": "Ten of Pentacles",
  "cups-13-queen": "Queen of Cups",
  "wands-14-king": "King of Wands",
};

const CELTIC_IDS = Object.keys(CARD_NAMES);

/** The ten cards the mock deals for a Celtic Cross, in position order (second one reversed). */
export const CELTIC_CARDS: DrawnCard[] = SPREADS[2].positions.map((p, i) => ({
  position: p.key,
  card_id: CELTIC_IDS[i],
  reversed: i === 1,
}));

export const DAILY_CARD: DrawnCard = { position: "card", card_id: "major-00-fool", reversed: false };

/** `alt` text the <Card> component renders: "<name>, upright|reversed". */
export function cardAlt(card: DrawnCard): string {
  return `${CARD_NAMES[card.card_id]}, ${card.reversed ? "reversed" : "upright"}`;
}

export const DAILY_TEXT = [
  "The Fool opens the day with a clean page.",
  "Step lightly into what the day offers; curiosity is the whole of the instruction.",
  "For reflection and entertainment.",
];

export const READING_TEXT = [
  "The cross speaks of a threshold: the Fool at the centre, crossed by the Magician reversed.",
  "Your Sun in Taurus steadies what the Hermit withdraws from, and the Star promises the long view.",
  "For reflection and entertainment.",
];

const PLACES = [
  { label: "Hull, MA, USA", lat: 42.3018, lon: -70.9078, tz: "America/New_York" },
  { label: "Hull, England, UK", lat: 53.7676, lon: -0.3274, tz: "Europe/London" },
];

const SIGNS = [
  "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
];
const LONGITUDES: Record<string, number> = {
  sun: 54.3, moon: 200, mercury: 70, venus: 20, mars: 130, jupiter: 250,
  saturn: 300, uranus: 10, neptune: 345, pluto: 275, north_node: 160,
};

function placement(lon: number, asc: number | null) {
  const signIdx = Math.floor((lon % 360) / 30);
  return {
    longitude: lon,
    sign: SIGNS[signIdx],
    degree: lon % 30,
    house: asc === null ? null : ((signIdx - Math.floor(asc / 30) + 12) % 12) + 1,
    retrograde: false,
  };
}

function chartFor(timeKnown: boolean) {
  const asc = timeKnown ? 95 : null;
  const planets: Record<string, ReturnType<typeof placement>> = {};
  for (const [body, lon] of Object.entries(LONGITUDES)) planets[body] = placement(lon, asc);
  return {
    engine_version: "e2e",
    time_known: timeKnown,
    planets,
    ascendant: asc === null ? null : placement(asc, asc),
    mc: asc === null ? null : placement((asc + 270) % 360, asc),
    aspects: [{ a: "sun", b: "moon", kind: "trine", orb: 1.2 }],
    houses_unavailable_reason: timeKnown ? null : "unknown_time",
  };
}

// ---- state ------------------------------------------------------------------

type User = { user_id: string; email: string | null; anon: boolean };
type Profile = {
  id: string;
  name: string;
  birth_date: string;
  birth_time: string | null;
  tz: string;
  lat: number;
  lon: number;
  place_label: string;
  time_known: boolean;
  created_at: string;
};
type Reading = {
  id: string;
  spread_type: string;
  cards: DrawnCard[];
  question: string | null;
  chart_id: string | null;
  text: string;
  status: string;
  created_at: string;
};

export interface MockState {
  /** bearer token → user */
  users: Record<string, User>;
  /** one shared credit balance (the specs run a single account) */
  balance: number;
  readings: Reading[];
  profiles: Profile[];
  spreads: Spread[];
  dailyReading: Reading | null;
  /** magic-link tokens issued by POST /auth/magic/request, oldest first */
  magicTokens: string[];
  pendingEmail: string | null;
}

export interface MockApiOptions {
  balance?: number;
}

export interface Calls {
  get: Record<string, number>;
  post: Record<string, number>;
  delete: Record<string, number>;
  options: Record<string, number>;
}

export interface MockApi {
  state: MockState;
  calls: Calls;
  /** Pretend the billing webhook landed: credits appear on the next GET /me. */
  simulateWebhook(credits: number): void;
}

// ---- helpers ----------------------------------------------------------------

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** Unsigned JWT with a `sub` claim — the client only ever decodes `sub`. */
function jwt(sub: string, extra: Record<string, unknown> = {}): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, iat: 1_700_000_000, ...extra }));
  return `${header}.${payload}.e2e`;
}

const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sseBody(readingId: string, cost: number, cards: DrawnCard[], paragraphs: string[]): string {
  const frames = [sseFrame("cards", { reading_id: readingId, cost, cards })];
  paragraphs.forEach((p, i) => {
    frames.push(sseFrame("delta", { text: i === 0 ? p : `\n\n${p}` }));
  });
  frames.push(sseFrame("done", { reading_id: readingId }));
  return frames.join("");
}

const excerpt = (text: string) => text.split(/\n\s*\n/)[0]?.slice(0, 140) ?? "";

function summary(r: Reading) {
  return {
    id: r.id,
    spread_type: r.spread_type,
    cards: r.cards,
    question: r.question,
    status: r.status,
    created_at: r.created_at,
    excerpt: excerpt(r.text),
  };
}

// ---- the mock ---------------------------------------------------------------

export async function mockApi(page: Page, opts: MockApiOptions = {}): Promise<MockApi> {
  const state: MockState = {
    users: {},
    balance: opts.balance ?? 0,
    readings: [],
    profiles: [],
    spreads: SPREADS,
    dailyReading: null,
    magicTokens: [],
    pendingEmail: null,
  };
  const calls: Calls = { get: {}, post: {}, delete: {}, options: {} };
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${++seq}`;
  let userSeq = 0;

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, message: string) =>
    json(route, status, { error: { code, message } });
  const noContent = (route: Route) => route.fulfill({ status: 204, body: "" });
  const sse = (route: Route, body: string) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body,
    });

  const userFor = (req: Request): User | null => {
    const auth = req.headers()["authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    return token ? state.users[token] ?? null : null;
  };

  const issueToken = (user: User): string => {
    const token = jwt(user.user_id, { anon: user.anon });
    state.users[token] = user;
    return token;
  };

  const spreadByType = (type: string) => state.spreads.find((s) => s.type === type);

  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method().toLowerCase() as keyof Calls;
    if (method in calls) calls[method][path] = (calls[method][path] ?? 0) + 1;

    // CORS preflight (Chromium sends one for JSON bodies and the bearer header).
    if (req.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": req.headers()["origin"] ?? "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": req.headers()["access-control-request-headers"] ?? "*",
          "access-control-max-age": "600",
        },
        body: "",
      });
    }

    // ---- auth (no bearer needed) ----
    if (method === "post" && path === "/auth/anonymous") {
      const user: User = { user_id: `anon-${++userSeq}`, email: null, anon: true };
      return json(route, 201, { token: issueToken(user), user_id: user.user_id });
    }
    if (method === "post" && path === "/auth/magic/verify") {
      const { token } = (req.postDataJSON() ?? {}) as { token?: string };
      const idx = token ? state.magicTokens.indexOf(token) : -1;
      if (idx === -1 || !state.pendingEmail) return error(route, 401, "unauthorized", "Link expired");
      state.magicTokens.splice(idx, 1); // single use
      const user: User = { user_id: `user-${++userSeq}`, email: state.pendingEmail, anon: false };
      return json(route, 200, { token: issueToken(user), user_id: user.user_id });
    }
    if (method === "post" && path === "/auth/google") {
      const user: User = { user_id: `google-${++userSeq}`, email: "google@example.com", anon: false };
      return json(route, 200, { token: issueToken(user), user_id: user.user_id });
    }
    if (method === "get" && path === "/spreads") return json(route, 200, state.spreads);

    // ---- everything else needs a known bearer ----
    const user = userFor(req);
    if (!user) return error(route, 401, "unauthorized", "Missing or invalid token");

    if (method === "post" && path === "/auth/refresh") return json(route, 200, { token: issueToken(user) });
    if (method === "get" && path === "/me") {
      return json(route, 200, { user_id: user.user_id, email: user.email, anon: user.anon, balance: state.balance });
    }
    if (method === "post" && path === "/auth/magic/request") {
      const { email } = (req.postDataJSON() ?? {}) as { email?: string };
      if (!email) return error(route, 422, "validation_failed", "email required");
      state.pendingEmail = email;
      state.magicTokens.push(nextId("m"));
      return route.fulfill({ status: 202, body: "" });
    }
    if (method === "delete" && path === "/account") {
      for (const [t, u] of Object.entries(state.users)) if (u === user) delete state.users[t];
      return noContent(route);
    }

    if (method === "get" && path === "/geocode") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(route, 200, PLACES.filter((p) => p.label.toLowerCase().includes(q)));
    }

    if (method === "post" && path === "/profiles") {
      const body = req.postDataJSON() as Omit<Profile, "id" | "time_known" | "created_at">;
      const profile: Profile = {
        ...body,
        id: nextId("p"),
        time_known: body.birth_time !== null,
        created_at: new Date().toISOString(),
      };
      state.profiles.push(profile);
      return json(route, 201, { profile, chart: chartFor(profile.time_known) });
    }
    if (method === "get" && path === "/profiles") return json(route, 200, { profiles: state.profiles });
    const profileMatch = /^\/profiles\/([^/]+)$/.exec(path);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      const idx = state.profiles.findIndex((p) => p.id === id);
      if (idx === -1) return error(route, 404, "not_found", "No such profile");
      if (method === "get") {
        const profile = state.profiles[idx];
        return json(route, 200, { profile, chart: chartFor(profile.time_known) });
      }
      if (method === "delete") {
        state.profiles.splice(idx, 1);
        return noContent(route);
      }
    }

    if (method === "post" && path === "/readings") {
      const body = (req.postDataJSON() ?? {}) as { spread_type: string; question?: string; profile_id?: string };
      const spread = spreadByType(body.spread_type);
      if (!spread) return error(route, 422, "validation_failed", "Unknown spread");
      if (state.balance < spread.credits) {
        return error(route, 402, "insufficient_credits", `This spread costs ${spread.credits} credits`);
      }
      const cards: DrawnCard[] =
        spread.type === "celtic_cross"
          ? CELTIC_CARDS
          : spread.positions.map((p, i) => ({ position: p.key, card_id: CELTIC_IDS[i], reversed: false }));
      const reading: Reading = {
        id: nextId("r"),
        spread_type: spread.type,
        cards,
        question: body.question ?? null,
        chart_id: body.profile_id ?? null,
        text: READING_TEXT.join("\n\n"),
        status: "complete",
        created_at: new Date().toISOString(),
      };
      state.balance -= spread.credits;
      state.readings.unshift(reading);
      return sse(route, sseBody(reading.id, spread.credits, cards, READING_TEXT));
    }
    const retryMatch = /^\/readings\/([^/]+)\/retry$/.exec(path);
    if (method === "post" && retryMatch) {
      const r = state.readings.find((x) => x.id === decodeURIComponent(retryMatch[1]));
      if (!r) return error(route, 404, "not_found", "No such reading");
      r.status = "complete";
      return sse(route, sseBody(r.id, 0, r.cards, r.text.split(/\n\s*\n/)));
    }
    if (method === "get" && path === "/readings") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      return json(route, 200, state.readings.slice(0, limit).map(summary));
    }
    const readingMatch = /^\/readings\/([^/]+)$/.exec(path);
    if (method === "get" && readingMatch) {
      const r = state.readings.find((x) => x.id === decodeURIComponent(readingMatch[1]));
      return r ? json(route, 200, r) : error(route, 404, "not_found", "No such reading");
    }

    if (method === "post" && path === "/daily") {
      if (state.dailyReading) return json(route, 200, { reading: state.dailyReading });
      const reading: Reading = {
        id: nextId("d"),
        spread_type: "daily",
        cards: [DAILY_CARD],
        question: null,
        chart_id: null,
        text: DAILY_TEXT.join("\n\n"),
        status: "complete",
        created_at: new Date().toISOString(),
      };
      state.dailyReading = reading;
      state.readings.unshift(reading);
      return sse(route, sseBody(reading.id, 0, reading.cards, DAILY_TEXT));
    }

    return error(route, 404, "not_found", `Unmocked ${req.method()} ${path}`);
  };

  await page.route(`${API_ORIGIN}/**`, handler);

  return {
    state,
    calls,
    simulateWebhook(credits: number) {
      state.balance += credits;
    },
  };
}

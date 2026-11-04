export const BODIES = [
  "sun", "moon", "mercury", "venus", "mars", "jupiter",
  "saturn", "uranus", "neptune", "pluto", "north_node",
] as const;
export type Body = (typeof BODIES)[number];

export interface Me {
  user_id: string;
  email: string | null;
  anon: boolean;
  balance: number;
}

export interface Profile {
  id: string;
  name: string;
  birth_date: string; // YYYY-MM-DD
  birth_time: string | null; // HH:MM
  tz: string;
  lat: number;
  lon: number;
  place_label: string;
  time_known: boolean;
  created_at: string;
}

export interface ProfileInput {
  name: string;
  birth_date: string;
  birth_time: string | null;
  tz: string;
  lat: number;
  lon: number;
  place_label: string;
}

export interface Placement {
  longitude: number;
  sign: string;
  degree: number;
  house: number | null;
  retrograde: boolean;
}

export interface Aspect {
  a: string;
  b: string;
  kind: string;
  orb: number;
}

export interface Chart {
  engine_version: string;
  time_known: boolean;
  planets: Record<Body, Placement>;
  ascendant: Placement | null;
  mc: Placement | null;
  aspects: Aspect[];
  houses_unavailable_reason: "unknown_time" | "polar_latitude" | null;
}

export interface ProfileWithChart {
  profile: Profile;
  chart: Chart;
}

export interface SpreadPosition {
  key: string;
  name: string;
  meaning: string;
}

export interface Spread {
  type: string;
  name: string;
  credits: number;
  positions: SpreadPosition[];
}

export interface DrawnCard {
  position: string;
  card_id: string;
  reversed: boolean;
}

export interface Reading {
  id: string;
  spread_type: string;
  cards: DrawnCard[];
  question: string | null;
  chart_id: string | null;
  text: string;
  status: string;
  created_at: string;
}

export interface ReadingSummary {
  id: string;
  spread_type: string;
  cards: DrawnCard[];
  question: string | null;
  status: string;
  created_at: string;
  excerpt: string;
}

export interface Place {
  label: string;
  lat: number;
  lon: number;
  tz: string;
}

export interface ReadingRequest {
  spread_type: string;
  question?: string;
  profile_id?: string;
}

export type SseEvent =
  | { event: "cards"; data: { reading_id: string; cost: number; cards: DrawnCard[] } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { reading_id: string } }
  | { event: "error"; data: { code: string; message: string } };

export type DailyResult =
  | { kind: "stream"; body: ReadableStream<Uint8Array> }
  | { kind: "reading"; reading: Reading };

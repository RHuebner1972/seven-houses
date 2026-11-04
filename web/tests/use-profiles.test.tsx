import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import { useCreateProfile, useDeleteProfile, useProfile, useProfiles } from "@/hooks/use-profiles";
import { apiBase } from "@/lib/api";

const BASE = apiBase();
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <RealProviders queryClient={qc}>{children}</RealProviders>
);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.clear();
  localStorage.setItem("sh.token", "tok");
});
afterEach(() => server.resetHandlers());

const p = { id: "p1", name: "Ada", birth_date: "1990-05-15", birth_time: null, tz: "UTC", lat: 0,
  lon: 0, place_label: "X", time_known: false, created_at: "x" };

test("useProfiles unwraps the list under ['profiles']", async () => {
  server.use(http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles: [p] })));
  const { result } = renderHook(() => useProfiles(), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual([p]));
  expect(qc.getQueryData(["profiles"])).toEqual([p]);
});

test("useProfile fetches under ['profile', id] and is disabled without an id", async () => {
  server.use(http.get(`${BASE}/profiles/p1`, () => HttpResponse.json({ profile: p, chart: null })));
  const { result } = renderHook(() => useProfile("p1"), { wrapper });
  await waitFor(() => expect(result.current.data?.profile.id).toBe("p1"));
  expect(qc.getQueryData(["profile", "p1"])).toBeDefined();
  const off = renderHook(() => useProfile(null), { wrapper });
  await new Promise((r) => setTimeout(r, 20));
  expect(off.result.current.fetchStatus).toBe("idle");
});

test("useCreateProfile and useDeleteProfile invalidate ['profiles']", async () => {
  let listed = 0;
  server.use(
    http.get(`${BASE}/profiles`, () => {
      listed++;
      return HttpResponse.json({ profiles: [p] });
    }),
    http.post(`${BASE}/profiles`, () => HttpResponse.json({ profile: p, chart: null }, { status: 201 })),
    http.delete(`${BASE}/profiles/p1`, () => new HttpResponse(null, { status: 204 })),
  );
  const list = renderHook(() => useProfiles(), { wrapper });
  await waitFor(() => expect(listed).toBe(1));
  await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

  const create = renderHook(() => useCreateProfile(), { wrapper });
  await act(() =>
    create.result.current.mutateAsync({ name: "Ada", birth_date: "1990-05-15", birth_time: null,
      tz: "UTC", lat: 0, lon: 0, place_label: "X" }),
  );
  await waitFor(() => expect(listed).toBe(2));

  const del = renderHook(() => useDeleteProfile(), { wrapper });
  await act(() => del.result.current.mutateAsync("p1"));
  await waitFor(() => expect(listed).toBe(3));
});

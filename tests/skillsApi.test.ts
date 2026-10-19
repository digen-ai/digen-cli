import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DigenClient, GATEWAY_PREFIX } from "../src/lib/client.js";
import { SkillsApi } from "../src/lib/skillsApi.js";

const BASE_URL = "https://api.example.test";
const SKILLS = `${BASE_URL}${GATEWAY_PREFIX}/api/v1/skills`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeApi(): SkillsApi {
  const client = new DigenClient({
    apiUrl: BASE_URL,
    token: "tok_abc",
    userId: 7,
    sessionId: "sess_1",
  });
  return new SkillsApi(client);
}

describe("SkillsApi", () => {
  it("lists the skill space", async () => {
    server.use(http.get(SKILLS, () => HttpResponse.json({ builtin: [], space: [{ id: 1 }] })));
    const data = await makeApi().list();
    expect(data.space).toEqual([{ id: 1 }]);
  });

  it("passes overlay_draft=false for published-only detail", async () => {
    server.use(
      http.get(`${SKILLS}/by-slug/demo`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("overlay_draft")).toBe("false");
        return HttpResponse.json({ id: 2, name: "demo" });
      }),
    );
    const skill = await makeApi().getBySlug("demo", { overlayDraft: false });
    expect(skill.name).toBe("demo");
  });

  it("creates a skill with the documented payload", async () => {
    server.use(
      http.post(SKILLS, async ({ request }) => {
        expect(await request.json()).toEqual({
          display_name: "Poster",
          description: "Use when...",
          body: "# Poster",
          allowed_tools: ["list_models"],
          visibility: "public",
          locales: ["zh"],
        });
        return HttpResponse.json({ id: 3, name: "poster" }, { status: 201 });
      }),
    );
    const data = await makeApi().create({
      display_name: "Poster",
      description: "Use when...",
      body: "# Poster",
      allowed_tools: ["list_models"],
      visibility: "public",
      locales: ["zh"],
    });
    expect(data.id).toBe(3);
  });

  it("sends zip import as multipart with visibility and locales", async () => {
    server.use(
      http.post(`${SKILLS}/import-zip`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("visibility")).toBe("public");
        expect(form.get("locales")).toBe('["zh","ko"]');
        const file = form.get("file");
        expect(file).toBeInstanceOf(File);
        expect((file as File).name).toBe("skill.zip");
        return HttpResponse.json({ id: 4, name: "zip-skill" }, { status: 201 });
      }),
    );
    const data = await makeApi().importZip(Buffer.from("zip-bytes"), {
      visibility: "public",
      locales: ["zh", "ko"],
    });
    expect(data.id).toBe(4);
  });

  it("updates an existing skill via PUT import-zip", async () => {
    server.use(
      http.put(`${SKILLS}/4/import-zip`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("visibility")).toBeNull();
        expect(form.get("file")).toBeInstanceOf(File);
        return HttpResponse.json({ id: 4, name: "zip-skill" });
      }),
    );
    const data = await makeApi().updateZip("4", Buffer.from("zip-bytes"));
    expect(data.id).toBe(4);
  });

  it("downloads an export zip as bytes", async () => {
    server.use(
      http.get(`${SKILLS}/4/export`, () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "Content-Type": "application/zip" },
        }),
      ),
    );
    const bytes = await makeApi().exportZip("4");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("updates listing and visibility with the documented bodies", async () => {
    server.use(
      http.put(`${SKILLS}/4/listing`, async ({ request }) => {
        expect(await request.json()).toEqual({
          slug: "poster",
          primary_category: "Poster",
          locales: ["zh"],
        });
        return HttpResponse.json({ id: 4 });
      }),
      http.put(`${SKILLS}/4/visibility`, async ({ request }) => {
        expect(await request.json()).toEqual({ visibility: "public" });
        return HttpResponse.json({ skill_id: 4, visibility: "public" });
      }),
      http.put(`${SKILLS}/4/content-visibility`, async ({ request }) => {
        expect(await request.json()).toEqual({ content_visibility: "closed" });
        return HttpResponse.json({ skill_id: 4, content_visibility: "closed" });
      }),
    );
    const api = makeApi();
    await api.updateListing("4", {
      slug: "poster",
      primary_category: "Poster",
      locales: ["zh"],
    });
    await api.setVisibility("4", "public");
    await api.setContentVisibility("4", "closed");
  });

  it("uploads preset assets and KB documents as multipart", async () => {
    server.use(
      http.post(`${SKILLS}/4/preset-assets/upload`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("key")).toBe("logo");
        expect(form.get("label")).toBe("Logo");
        expect(form.get("write_to_draft")).toBe("false");
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${SKILLS}/4/kb-documents/upload`, async ({ request }) => {
        const form = await request.formData();
        expect(form.get("doc_id")).toBe("faq");
        expect(form.get("title")).toBe("FAQ");
        expect(form.get("write_to_draft")).toBe("true");
        return HttpResponse.json({ ok: true });
      }),
    );
    const api = makeApi();
    const file = { bytes: Buffer.from("x"), filename: "logo.png", contentType: "image/png" };
    await api.uploadPresetAsset("4", file, "logo", { label: "Logo", writeToDraft: false });
    await api.uploadKbDocument(
      "4",
      { bytes: Buffer.from("x"), filename: "faq.pdf", contentType: "application/pdf" },
      { docId: "faq", title: "FAQ", writeToDraft: true },
    );
  });

  it("shares, reports, and fetches creator stats", async () => {
    server.use(
      http.post(`${SKILLS}/4/share`, async ({ request }) => {
        expect(await request.json()).toEqual({ regenerate: true });
        return HttpResponse.json({ ok: true, share_token: "tok" });
      }),
      http.post(`${SKILLS}/4/report`, async ({ request }) => {
        expect(await request.json()).toEqual({ reason: "spam" });
        return HttpResponse.json({ ok: true, report_id: 9 });
      }),
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/creator/overview`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("from")).toBe("2026-09-01");
        expect(url.searchParams.get("to")).toBe("2026-09-07");
        return HttpResponse.json({ uses: 2, skills: [] });
      }),
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/creator/skills/4/stats`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("period")).toBe("7d");
        return HttpResponse.json({ uses: 1 });
      }),
    );
    const api = makeApi();
    expect((await api.createShare("4", true)).share_token).toBe("tok");
    expect((await api.report("4", "spam")).report_id).toBe(9);
    expect((await api.getCreatorOverview("2026-09-01", "2026-09-07")).uses).toBe(2);
    expect((await api.getCreatorSkillStats("4", { period: "7d" })).uses).toBe(1);
  });
});

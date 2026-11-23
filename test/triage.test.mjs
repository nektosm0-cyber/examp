// Запуск: npm test (или node --test) из корня проекта.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer } from "../server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createTriageServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

function postJson(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("корректная заявка: тема и непустой черновик", async () => {
  const response = await postJson({ text: "Не пришла доставка, где мой заказ?" });
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "delivery");
  assert.equal(typeof data.draft, "string");
  assert.ok(data.draft.trim().length > 0);
});

test("пустой, отсутствующий и нестроковый текст отклоняются", async () => {
  for (const body of [{ text: "" }, { text: "   " }, {}, { text: 42 }, { text: null }]) {
    const response = await postJson(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
});

test("битый JSON отклоняется", async () => {
  const response = await postJson('{"text": "доставка"');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${marker}: ручной разбор без черновика`, async () => {
    const response = await postJson({ text: `Заявка ${marker}` });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "manual_review",
      topic: null,
      draft: null,
    });
  });
}

test("таймаут модели прерывается за 300 мс", async () => {
  const started = performance.now();
  const response = await postJson({ text: "Заявка [timeout]" });
  const elapsed = performance.now() - started;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "manual_review",
    topic: null,
    draft: null,
  });
  assert.ok(elapsed < 1000, `ответ занял ${Math.round(elapsed)} мс`);
});

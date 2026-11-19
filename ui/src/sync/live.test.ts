// @vitest-environment node
// Runs against a real service: `VARIA_LIVE=http://127.0.0.1:8099 npx vitest run src/sync/live.test.ts`
// with `VARIA_DB` on a scratch file. Skipped otherwise, so the normal suite needs no server.
import { expect, it } from 'vitest';
import { testRepo } from '../db/inProcess';
import { newRootKey, opKey } from './crypto';
import { syncNow } from './client';
import { httpTransport } from './http';

const base = process.env.VARIA_LIVE;

it.skipIf(!base)('talks to the real service', async () => {
  const token = (await (await fetch(`${base}/api/signup`, { method: 'POST', body: '{}' })).json()).token as string;
  expect(token).toHaveLength(64);

  const key = await opKey(newRootKey());
  const transport = httpTransport(base!);
  const a = testRepo('device-live-a');
  const id = await a.createNote('note');
  await a.saveBody(id, '# live\nthe wire format works');

  const sent = await syncNow({ repo: a, key, token, transport });
  expect(sent.pushed).toBe(2);
  expect(await a.unpushed()).toHaveLength(0);

  const b = testRepo('device-live-b');
  const received = await syncNow({ repo: b, key, token, transport });
  expect(received.pulled).toBe(2);
  expect((await b.getNote(id))?.body).toBe('# live\nthe wire format works');

  // A second sync from the already-caught-up device changes nothing.
  const again = await syncNow({ repo: b, key, token, transport });
  expect(again).toMatchObject({ pushed: 0, pulled: 0 });
});

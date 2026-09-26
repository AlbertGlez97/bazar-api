import { Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureCors } from './cors.js';

@Controller('ping')
class PingController {
  @Get()
  get() {
    return { ok: true };
  }

  @Post()
  post() {
    return { ok: true };
  }
}

const PREFLIGHT_HEADERS =
  'authorization,content-type,x-member-id,x-device-id,x-device-token';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createApp(allowedOrigin: string | undefined) {
  if (allowedOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
  else process.env.ALLOWED_ORIGIN = allowedOrigin;

  const moduleRef = await Test.createTestingModule({
    controllers: [PingController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureCors(app);
  await app.init();
  return app;
}

function preflight(
  app: NestExpressApplication,
  origin: string,
  headers = PREFLIGHT_HEADERS,
) {
  return request(app.getHttpServer())
    .options('/ping')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headers);
}

describe('configureCors', () => {
  const saved = process.env.ALLOWED_ORIGIN;
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (saved === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = saved;
  });

  describe.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['only separators', ' , ,'],
  ])('when ALLOWED_ORIGIN is %s', (_label, value) => {
    it('keeps CORS off: no Access-Control-Allow-Origin on a simple request', async () => {
      app = await createApp(value);
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', 'https://site.netlify.app');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not answer the preflight as CORS', async () => {
      app = await createApp(value);
      const res = await preflight(app, 'https://site.netlify.app');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toBeUndefined();
    });
  });

  it('answers the preflight of an allowed origin with 204 and the five API headers', async () => {
    app = await createApp('https://site.netlify.app');
    const res = await preflight(app, 'https://site.netlify.app');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://site.netlify.app',
    );
    const allowed = String(res.headers['access-control-allow-headers'])
      .toLowerCase()
      .split(',')
      .map((h) => h.trim());
    expect(allowed).toEqual(
      expect.arrayContaining([
        'authorization',
        'content-type',
        'x-member-id',
        'x-device-id',
        'x-device-token',
      ]),
    );
    expect(String(res.headers['access-control-allow-methods'])).toContain(
      'POST',
    );
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('adds the allow-origin header to the real request of an allowed origin', async () => {
    app = await createApp('https://site.netlify.app');
    const res = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'https://site.netlify.app');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://site.netlify.app',
    );
  });

  it('does not allow an origin outside the list', async () => {
    app = await createApp('https://site.netlify.app');
    const res = await preflight(app, 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    const simple = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'https://evil.example');
    expect(simple.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not treat a lookalike of an allowed origin as allowed', async () => {
    app = await createApp('https://site.netlify.app');
    for (const origin of [
      'https://site.netlify.app.evil.example',
      'http://site.netlify.app',
      'https://site.netlify.app:8443',
    ]) {
      const res = await preflight(app, origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('works exactly as before for a request without Origin (Vite proxy, curl)', async () => {
    app = await createApp('https://site.netlify.app');
    const res = await request(app.getHttpServer()).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('trims entries, drops trailing slashes and accepts several origins', async () => {
    app = await createApp(' https://a.netlify.app/ , https://b.example ');
    for (const origin of ['https://a.netlify.app', 'https://b.example']) {
      const res = await preflight(app, origin);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
    const other = await preflight(app, 'https://c.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([['*'], ['https://a.netlify.app, *'], [' * ']])(
    'refuses a wildcard at startup: %j',
    async (value) => {
      await expect(createApp(value)).rejects.toThrow(/ALLOWED_ORIGIN/);
    },
  );

  it('refuses a partial wildcard at startup, naming the entry', async () => {
    await expect(createApp('https://*.netlify.app')).rejects.toThrow(
      /ALLOWED_ORIGIN.*wildcard.*https:\/\/\*\.netlify\.app/s,
    );
  });

  // Entries that can never equal a browser Origin header used to pass
  // silently: the API started fine and the browser blocked every request.
  it.each([
    ['a path', 'https://x.netlify.app/app', 'https://x.netlify.app'],
    ['a query string', 'https://x.netlify.app?x=1', 'https://x.netlify.app'],
    ['upper-case letters', 'https://X.Netlify.app', 'https://x.netlify.app'],
    [
      'an explicit default port',
      'https://x.netlify.app:443',
      'https://x.netlify.app',
    ],
    ['credentials', 'https://user@x.netlify.app', 'https://x.netlify.app'],
  ])(
    'refuses an entry with %s at startup and hints the exact origin',
    async (_label, entry, hint) => {
      await expect(createApp(entry)).rejects.toThrow(
        new RegExp(
          `ALLOWED_ORIGIN.*${escapeRegExp(entry)}.*${escapeRegExp(hint)}`,
          's',
        ),
      );
    },
  );

  it.each([['x.netlify.app'], ['//x.netlify.app'], ['not a url']])(
    'refuses an entry that is not a URL at startup: %j',
    async (entry) => {
      await expect(createApp(entry)).rejects.toThrow(
        new RegExp(`ALLOWED_ORIGIN.*${escapeRegExp(entry)}`, 's'),
      );
    },
  );

  it.each([['ftp://x.example'], ['localhost:5173'], ['file:///tmp']])(
    'refuses a scheme other than http or https at startup: %j',
    async (entry) => {
      await expect(createApp(entry)).rejects.toThrow(
        new RegExp(`ALLOWED_ORIGIN.*${escapeRegExp(entry)}.*http`, 's'),
      );
    },
  );

  it('fails on one bad entry in a list and names that entry, not the good ones', async () => {
    const error = await createApp(
      'https://a.netlify.app, https://b.netlify.app/app',
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('https://b.netlify.app/app');
    expect(error?.message).not.toContain('"https://a.netlify.app"');
  });

  it('accepts localhost with a non-default port next to a trimmed origin with a trailing slash', async () => {
    app = await createApp(' https://a.netlify.app/ , http://localhost:5173 ');
    for (const origin of ['https://a.netlify.app', 'http://localhost:5173']) {
      const res = await preflight(app, origin);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('does not allow a request header outside the list', async () => {
    app = await createApp('https://site.netlify.app');
    const res = await preflight(
      app,
      'https://site.netlify.app',
      'authorization,x-evil',
    );
    const allowed = String(res.headers['access-control-allow-headers'] ?? '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim());
    expect(allowed).not.toContain('x-evil');
  });
});

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApiDocs } from '../src/docs/swagger.js';

describe('API documentation exposure', () => {
  const saved = { ...process.env };
  let app: NestExpressApplication;
  afterEach(async () => {
    await app?.close();
    for (const key of ['ENABLE_API_DOCS', 'DOCS_USER', 'DOCS_PASSWORD']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  async function start() {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApiDocs(app);
    await app.listen(0, '127.0.0.1');
    return app.getUrl();
  }
  it('does not register UI or documents without explicit opt-in', async () => {
    delete process.env.ENABLE_API_DOCS;
    const url = await start();
    for (const path of ['/docs', '/docs-json', '/docs-yaml']) {
      expect((await fetch(url + path)).status).toBe(404);
    }
  });
  it('requires independent Basic credentials for UI and raw documents', async () => {
    process.env.ENABLE_API_DOCS = 'true';
    process.env.DOCS_USER = 'verification';
    process.env.DOCS_PASSWORD = randomBytes(24).toString('hex');
    const url = await start();
    for (const path of ['/docs', '/docs-json', '/docs-yaml']) {
      expect((await fetch(url + path)).status).toBe(401);
      expect(
        (
          await fetch(url + path, {
            headers: {
              Authorization:
                'Basic ' + Buffer.from('wrong:wrong').toString('base64'),
            },
          })
        ).status,
      ).toBe(401);
      const authorized = await fetch(url + path, {
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${process.env.DOCS_USER}:${process.env.DOCS_PASSWORD}`,
            ).toString('base64'),
        },
      });
      expect(authorized.status).toBe(200);
    }
  });
  it('documents every approve outcome that shares a status, not only the last one', async () => {
    process.env.ENABLE_API_DOCS = 'true';
    process.env.DOCS_USER = 'verification';
    process.env.DOCS_PASSWORD = randomBytes(24).toString('hex');
    const url = await start();
    const res = await fetch(url + '/docs-json', {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            `${process.env.DOCS_USER}:${process.env.DOCS_PASSWORD}`,
          ).toString('base64'),
      },
    });
    const document = (await res.json()) as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<
              string,
              {
                content: Record<
                  string,
                  { examples: Record<string, { value: string }> }
                >;
              }
            >;
          };
        }
      >;
    };
    const responses =
      document.paths['/business-registration/approve'].get.responses;
    const htmlOf = (status: string) =>
      Object.values(responses[status].content['text/html'].examples)
        .map((example) => example.value)
        .join('\n');

    const conflicts = htmlOf('502');
    expect(conflicts).toContain('No se pudo enviar el correo de credenciales');
    expect(conflicts).toContain('La aprobación tardó demasiado');
    expect(conflicts).toContain('No se pudo crear el usuario');
    expect(htmlOf('200')).toContain('Negocio aprobado');
  });
});

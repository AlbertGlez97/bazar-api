// Pruebas unitarias del controlador del registro: el servicio es un doble, la capa HTTP es real
// (Nest + ValidationPipe + supertest), así que se afirma lo que ve quien llama: códigos, cuerpos,
// validación y a qué se le pasó qué. Sin base de datos.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import request from 'supertest';
import { BusinessRegistrationController } from './business-registration.controller.js';
import { BusinessRegistrationService } from './business-registration.service.js';

const body = (over: Record<string, unknown> = {}) => ({
  nombreNegocio: 'Abarrotes Los Pinos',
  tipoNegocio: 'abarrotes',
  queVende: 'Abarrotes, dulces y refrescos',
  nombre: 'Ana',
  apellidos: 'Pérez Soto',
  correo: 'ana@example.com',
  telefono: '55 1234 5678',
  aceptaLegal: true,
  versionLegal: '2026-10-19',
  turnstileToken: 'token-turnstile',
  ...over,
});

describe('BusinessRegistrationController', () => {
  let app: INestApplication;
  const service = {
    create: vi.fn(),
    verifyEmail: vi.fn(),
    resend: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BusinessRegistrationController],
      providers: [{ provide: BusinessRegistrationService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    service.create.mockResolvedValue(undefined);
    service.verifyEmail.mockResolvedValue(undefined);
    service.resend.mockResolvedValue(undefined);
    service.approve.mockResolvedValue({ statusCode: 200, html: '<p>aprobada</p>' });
    service.reject.mockResolvedValue({ statusCode: 200, html: '<p>rechazada</p>' });
  });

  describe('POST /business-registration', () => {
    it('responde 202 y SIEMPRE { ok: true }', async () => {
      const res = await http().post('/business-registration').send(body()).expect(202);

      expect(res.body).toEqual({ ok: true });
    });

    it('le pasa al servicio el cuerpo ya limpio (teléfono a 10 dígitos, correo sin espacios; el servicio lo pasa a minúsculas) y la IP de CF-Connecting-IP', async () => {
      await http()
        .post('/business-registration')
        .set('CF-Connecting-IP', '203.0.113.7')
        .send(body({ correo: '  ANA@Example.com ', telefono: '+52 (55) 1234-5678' }))
        .expect(400); // paréntesis: el servidor no los acepta

      await http()
        .post('/business-registration')
        .set('CF-Connecting-IP', '203.0.113.7')
        .send(body({ correo: '  ANA@Example.com ', telefono: '+52 55 1234 5678' }))
        .expect(202);

      expect(service.create).toHaveBeenCalledTimes(1);
      const [dto, ip] = service.create.mock.calls[0];
      expect(ip).toBe('203.0.113.7');
      expect(dto).toMatchObject({ correo: 'ANA@Example.com', telefono: '5512345678', turnstileToken: 'token-turnstile' });
    });

    it('rechaza con 400 un campo desconocido (no hay campos de redes ni de mapas) y no llama al servicio', async () => {
      await http().post('/business-registration').send(body({ facebook: 'https://facebook.com/x' })).expect(400);
      await http().post('/business-registration').send(body({ mapa: 'https://maps.google.com/?q=1' })).expect(400);

      expect(service.create).not.toHaveBeenCalled();
    });

    it.each([
      ['sin la casilla legal', { aceptaLegal: false }],
      ['sin token de Turnstile', { turnstileToken: '' }],
      ['con un tipo de negocio que no existe', { tipoNegocio: 'banco' }],
      ['con un teléfono que no es de México', { telefono: '+1 555 123 4567' }],
      ['con un correo mal escrito', { correo: 'ana@' }],
      ['con una versión legal que no es fecha', { versionLegal: 'ayer' }],
      ['con "qué vende" demasiado corto', { queVende: 'ropa' }],
    ])('responde 400 %s y no llama al servicio', async (_label, over) => {
      await http().post('/business-registration').send(body(over)).expect(400);

      expect(service.create).not.toHaveBeenCalled();
    });

    it('acepta el campo trampa y se lo pasa al servicio (él decide ignorar la solicitud)', async () => {
      await http().post('/business-registration').send(body({ sitioWebEmpresa: 'http://spam.example' })).expect(202);

      expect(service.create.mock.calls[0][0]).toMatchObject({ sitioWebEmpresa: 'http://spam.example' });
    });

    it('si el servicio responde 400 de Turnstile o 503, el cuerpo llega tal cual al cliente', async () => {
      service.create.mockRejectedValueOnce(new BadRequestException({ statusCode: 400, code: 'turnstile_invalid', message: 'no' }));
      const invalid = await http().post('/business-registration').send(body()).expect(400);
      expect(invalid.body).toMatchObject({ code: 'turnstile_invalid' });

      service.create.mockRejectedValueOnce(new ServiceUnavailableException({ statusCode: 503, code: 'email_unavailable', message: 'no' }));
      const unavailable = await http().post('/business-registration').send(body()).expect(503);
      expect(unavailable.body).toMatchObject({ code: 'email_unavailable' });
    });
  });

  describe('POST /business-registration/verify-email', () => {
    const token = 'a'.repeat(43);

    it('responde 200 { ok: true } y le pasa al servicio SOLO el token', async () => {
      const res = await http().post('/business-registration/verify-email').send({ token }).expect(200);

      expect(res.body).toEqual({ ok: true });
      expect(service.verifyEmail).toHaveBeenCalledExactlyOnceWith(token);
    });

    it('NO existe por GET (los escáneres de correo no pueden confirmar)', async () => {
      await http().get(`/business-registration/verify-email?token=${token}`).expect(404);

      expect(service.verifyEmail).not.toHaveBeenCalled();
    });

    it.each([
      ['sin token', {}],
      ['con un token demasiado corto', { token: 'corto' }],
      ['con un token demasiado largo', { token: 'a'.repeat(201) }],
      ['con campos de más', { token, correo: 'ana@example.com' }],
    ])('responde 400 %s', async (_label, payload) => {
      await http().post('/business-registration/verify-email').send(payload).expect(400);

      expect(service.verifyEmail).not.toHaveBeenCalled();
    });

    it('el 400 "link_invalid" del servicio llega igual al cliente', async () => {
      service.verifyEmail.mockRejectedValueOnce(new BadRequestException({ statusCode: 400, code: 'link_invalid', message: 'x' }));

      const res = await http().post('/business-registration/verify-email').send({ token }).expect(400);

      expect(res.body).toMatchObject({ code: 'link_invalid' });
    });
  });

  describe('POST /business-registration/resend', () => {
    it('responde 202 { ok: true } y le pasa el correo al servicio', async () => {
      const res = await http().post('/business-registration/resend').send({ correo: 'ana@example.com' }).expect(202);

      expect(res.body).toEqual({ ok: true });
      expect(service.resend).toHaveBeenCalledExactlyOnceWith('ana@example.com');
    });

    it.each([['sin correo', {}], ['con un correo mal escrito', { correo: 'ana@' }], ['con campos de más', { correo: 'ana@example.com', x: 1 }]])(
      'responde 400 %s',
      async (_label, payload) => {
        await http().post('/business-registration/resend').send(payload).expect(400);

        expect(service.resend).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /business-registration/approve y /reject (enlaces del correo del aprobador)', () => {
    it.each(['approve', 'reject'])('%s sin token responde 404 con una página HTML de "Enlace inválido" y no llama al servicio', async (action) => {
      const res = await http().get(`/business-registration/${action}`).expect(404);

      expect(res.type).toBe('text/html');
      expect(res.text).toContain('Enlace inválido');
      expect(service.approve).not.toHaveBeenCalled();
      expect(service.reject).not.toHaveBeenCalled();
    });

    it('approve con token entrega el código y el HTML que devuelve el servicio', async () => {
      service.approve.mockResolvedValue({ statusCode: 502, html: '<p>reintenta</p>' });

      const res = await http().get('/business-registration/approve?token=abc').expect(502);

      expect(res.type).toBe('text/html');
      expect(res.text).toBe('<p>reintenta</p>');
      expect(service.approve).toHaveBeenCalledExactlyOnceWith('abc');
    });

    it('reject con token entrega el código y el HTML que devuelve el servicio', async () => {
      const res = await http().get('/business-registration/reject?token=xyz').expect(200);

      expect(res.text).toBe('<p>rechazada</p>');
      expect(service.reject).toHaveBeenCalledExactlyOnceWith('xyz');
      expect(service.approve).not.toHaveBeenCalled();
    });
  });
});

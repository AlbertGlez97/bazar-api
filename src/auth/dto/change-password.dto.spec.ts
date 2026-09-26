import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ChangePasswordDto,
  MAX_PASSWORD_LENGTH,
  MIN_NEW_PASSWORD_LENGTH,
} from './change-password.dto.js';

const valid = {
  currentPassword: 'Tmp-Pass_9x7Qk2LmZ4vB',
  newPassword: 'a-brand-new-secret',
};

// Same options as the controller's ValidationPipe.
const check = async (body: unknown) => {
  const dto = plainToInstance(
    ChangePasswordDto,
    body as Record<string, unknown>,
  );
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return {
    dto,
    properties: errors.map((error) => error.property),
    messages: errors.flatMap((error) => Object.values(error.constraints ?? {})),
  };
};

describe('ChangePasswordDto', () => {
  it('accepts a current password and a different new one', async () => {
    const { properties } = await check(valid);

    expect(properties).toEqual([]);
  });

  it('exposes the limits it enforces', () => {
    expect(MIN_NEW_PASSWORD_LENGTH).toBe(10);
    expect(MAX_PASSWORD_LENGTH).toBe(128);
  });

  it.each([
    ['no body fields', {}],
    ['no currentPassword', { newPassword: valid.newPassword }],
    ['no newPassword', { currentPassword: valid.currentPassword }],
  ])('rejects %s', async (_label, body) => {
    const { properties } = await check(body);

    expect(properties.length).toBeGreaterThan(0);
  });

  it.each([
    ['a number', 1234567890],
    ['null', null],
    ['an object', { a: 1 }],
    ['an array', ['a-brand-new-secret']],
    ['a boolean', true],
  ])('rejects %s as newPassword', async (_label, newPassword) => {
    const { properties } = await check({ ...valid, newPassword });

    expect(properties).toContain('newPassword');
  });

  it.each([
    ['a number', 12345],
    ['null', null],
    ['an array', ['x']],
  ])('rejects %s as currentPassword', async (_label, currentPassword) => {
    const { properties } = await check({ ...valid, currentPassword });

    expect(properties).toContain('currentPassword');
  });

  it('rejects a currentPassword that is empty or longer than 128 characters', async () => {
    expect((await check({ ...valid, currentPassword: '' })).properties).toContain(
      'currentPassword',
    );
    expect(
      (await check({ ...valid, currentPassword: 'x'.repeat(129) })).properties,
    ).toContain('currentPassword');
    expect(
      (await check({ ...valid, currentPassword: 'x'.repeat(128) })).properties,
    ).toEqual([]);
  });

  it('enforces 10..128 characters on newPassword, boundaries included', async () => {
    expect(
      (await check({ ...valid, newPassword: 'x'.repeat(9) })).properties,
    ).toContain('newPassword');
    expect(
      (await check({ ...valid, newPassword: 'x'.repeat(10) })).properties,
    ).toEqual([]);
    expect(
      (await check({ ...valid, newPassword: 'x'.repeat(128) })).properties,
    ).toEqual([]);
    expect(
      (await check({ ...valid, newPassword: 'x'.repeat(129) })).properties,
    ).toContain('newPassword');
  });

  it('rejects a newPassword equal to the currentPassword', async () => {
    const { properties, messages } = await check({
      currentPassword: 'the-very-same-secret',
      newPassword: 'the-very-same-secret',
    });

    expect(properties).toContain('newPassword');
    expect(messages.join(' ')).toMatch(/differ/i);
  });

  it('does not trim or otherwise alter the passwords', async () => {
    const { dto, properties } = await check({
      currentPassword: '  spaced-current  ',
      newPassword: '  spaced-new-secret  ',
    });

    expect(properties).toEqual([]);
    expect(dto.currentPassword).toBe('  spaced-current  ');
    expect(dto.newPassword).toBe('  spaced-new-secret  ');
  });

  it('treats passwords that differ only by case or by a trailing space as different', async () => {
    expect(
      (
        await check({
          currentPassword: 'Same-Secret-123',
          newPassword: 'same-secret-123',
        })
      ).properties,
    ).toEqual([]);
    expect(
      (
        await check({
          currentPassword: 'Same-Secret-123',
          newPassword: 'Same-Secret-123 ',
        })
      ).properties,
    ).toEqual([]);
  });

  it('rejects unknown properties', async () => {
    const { properties } = await check({ ...valid, username: 'someone-else' });

    expect(properties).toContain('username');
  });

  it('never puts a password in a validation message', async () => {
    const secret = 'short-1';
    const { messages } = await check({
      currentPassword: 'the-current-secret',
      newPassword: secret,
    });

    expect(messages.join(' ')).not.toContain(secret);
    expect(messages.join(' ')).not.toContain('the-current-secret');
  });
});

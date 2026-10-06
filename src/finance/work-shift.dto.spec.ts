import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v7 } from 'uuid';
import {
  CreateWorkShiftDto,
  WorkShiftListDto,
  ReverseWorkShiftDto,
} from './work-shift.dto.js';

const body = () => ({
  id: v7(),
  memberId: v7(),
  workDate: '2026-10-05',
  createdByMemberId: v7(),
  deviceId: v7(),
});
describe('work shift validation', () => {
  it.each([undefined, null, 1, 1500, 2147483647])(
    'accepts unknown or positive minutes %s without a daily cap',
    async (minutes) => {
      expect(
        await validate(
          plainToInstance(CreateWorkShiftDto, { ...body(), minutes }),
        ),
      ).toHaveLength(0);
    },
  );
  it.each([0, -1, 1.5, '60', 2147483648])(
    'rejects invalid minutes %s',
    async (minutes) => {
      expect(
        await validate(
          plainToInstance(CreateWorkShiftDto, { ...body(), minutes }),
        ),
      ).not.toHaveLength(0);
    },
  );
  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-1-01',
    '2026-10-05T00:00:00Z',
    '0000-01-01',
  ])('rejects invalid calendar date %s', async (workDate) => {
    expect(
      await validate(
        plainToInstance(CreateWorkShiftDto, { ...body(), workDate }),
      ),
    ).not.toHaveLength(0);
  });
  it('accepts leap day and query limits', async () => {
    expect(
      await validate(
        plainToInstance(CreateWorkShiftDto, {
          ...body(),
          workDate: '2028-02-29',
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(WorkShiftListDto, {
          limit: '100',
          duration: 'unknown',
        }),
      ),
    ).toHaveLength(0);
  });

  it.each(['2026-10-05', '2026-10-05T12:00:00', '2026-10-05T12:00:00.1234Z'])(
    'rejects unzoned or excessive precision correction instant %s',
    async (occurredAt) => {
      expect(
        await validate(
          plainToInstance(ReverseWorkShiftDto, {
            id: v7(),
            reason: 'Correction',
            occurredAt,
            createdByMemberId: v7(),
            deviceId: v7(),
          }),
        ),
      ).not.toHaveLength(0);
    },
  );
  it('validates nested replacement and preserves optional durations', async () => {
    const dto = {
      id: v7(),
      reason: 'Correction',
      occurredAt: '2026-10-05T12:00:00.123Z',
      createdByMemberId: v7(),
      deviceId: v7(),
      replacement: { ...body(), minutes: null },
    };
    expect(
      await validate(plainToInstance(ReverseWorkShiftDto, dto)),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ReverseWorkShiftDto, {
          ...dto,
          replacement: { ...body(), minutes: 0 },
        }),
      ),
    ).not.toHaveLength(0);
  });
});

/**
 * A tiny in-memory stand-in for one Prisma model, for unit tests of services.
 * It understands plain equality, `{ in: [...] }`, `{ gte: x }` and `{ lt: x }`
 * filters and a single-key `orderBy`. Real database behavior (triggers, unique
 * indexes, row-level security) belongs to the e2e specs.
 */
export type Row = Record<string, any>;

export const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, expected]) => {
    // `NOT: { ... }` is true when the row does NOT match every condition inside.
    if (key === 'NOT') return !match(row, expected);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('in' in expected) return (expected.in as unknown[]).includes(row[key]);
      if ('gte' in expected) return row[key] >= expected.gte;
      if ('gt' in expected) return row[key] > expected.gt;
      if ('lt' in expected) return row[key] < expected.lt;
      if ('not' in expected) return (row[key] ?? null) !== expected.not;
    }
    // A column that was never set reads as NULL, like in the database.
    return (row[key] ?? null) === expected;
  });

export function table(rows: Row[]) {
  const sorted = (list: Row[], orderBy?: Row | Row[]) => {
    const [first] = ([] as Row[]).concat(orderBy ?? []);
    if (!first) return list;
    const [key, dir] = Object.entries(first)[0] as [string, string];
    const factor = dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => (a[key] > b[key] ? factor : a[key] < b[key] ? -factor : 0));
  };
  return {
    rows,
    findMany: async ({ where, orderBy, take }: Row = {}) =>
      sorted(rows.filter((r) => match(r, where)), orderBy).slice(0, take ?? rows.length),
    findFirst: async ({ where, orderBy }: Row = {}) =>
      sorted(rows.filter((r) => match(r, where)), orderBy)[0] ?? null,
    count: async ({ where }: Row = {}) => rows.filter((r) => match(r, where)).length,
    create: async ({ data }: Row) => {
      const row = { createdAt: new Date(), approvedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: Row) => {
      const row = rows.find((r) => match(r, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: Row) => {
      const keep = rows.filter((r) => !match(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

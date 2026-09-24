import { v7 as uuidv7 } from 'uuid';

/**
 * Creates an identifier for records owned by the backend.
 *
 * UUIDv7 keeps the uniqueness properties of UUIDs while placing the
 * timestamp in the most significant bits, so newly inserted rows are
 * substantially friendlier to ordered database indexes than random UUIDv4.
 */
export function createServerId(): string {
  return uuidv7();
}

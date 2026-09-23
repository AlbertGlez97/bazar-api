// Single source of truth for the access token lifetime, shared between the
// JwtModule sign/verify options (auth.module.ts) and the value AuthService
// reports back to the client in the login response body. Keeping this in
// one place avoids the two ever silently drifting apart (as plain seconds,
// so both the `jsonwebtoken` `expiresIn` option, which accepts a number of
// seconds, and the login response can use it directly).
export const JWT_EXPIRES_IN_SECONDS = 12 * 60 * 60;

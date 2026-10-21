# Invitación a una cuenta personal (F1b)

Un socio que usa el acceso compartido no puede aprobar reglas de reparto cuando hay más de un socio.
Esta función le da una cuenta personal, atada a su socio. El acceso compartido no se toca: la tablet
sigue eligiendo quién vende con `x-member-id`.

No hay contraseña temporal por correo. El correo lleva un enlace de un solo uso. La persona elige su propia contraseña.

## Flujo

1. Un socio activo invita a otro socio activo que no tiene cuenta propia:
   `POST /members/:id/invitation` con `{ "email": "..." }`.
2. El servidor genera 32 bytes aleatorios. Guarda solo el SHA-256 del token. El correo lleva
   `PUBLIC_SITE_URL/invitacion/<token>`.
3. La persona abre el enlace. La página llama `POST /invitations/inspect`, que solo consulta. No consume nada,
   así que un escáner de correo no gasta el enlace.
4. La persona escribe su contraseña y pulsa "Crear mi contraseña": `POST /invitations/accept`. Se crea la cuenta
   atada al socio y se gasta el enlace, en una sola transacción.
5. La página lleva al login con el correo ya escrito (`/login?email=...&created=1`) y el aviso "Cuenta creada, ya puedes entrar".
   No inicia sesión sola.

## Reglas

- El enlace dura 72 horas y sirve una vez.
- Máximo 3 invitaciones por socio en 24 horas y 1 minuto entre envíos. Un reenvío invalida el enlace anterior.
- Usuario = correo normalizado, igual que `POST /members`. Mismo máximo de 100 caracteres.
- Contraseña: de 10 a 128 caracteres, igual que el cambio de contraseña. Se usa tal como se escribe.
- Solo socios activos del mismo negocio invitan. Los colaboradores reciben 403.
- Se invita solo a un socio activo sin cuenta atada. Si ya tiene, 409.
- Máximo 10 personas nuevas por socio que invita en 24 horas. Los reenvíos no cuentan. Al pasarse, 429 `INVITATION_NEW_DAILY_LIMIT`.

## Quién puede invitar a quién

El acceso compartido (cuenta sin `memberId`) no puede probar quién lo usa. Por eso:

1. Mientras **ningún socio activo** tenga cuenta personal atada, el acceso compartido solo puede invitar al **socio elegido en ese
   momento** (`x-member-id`). Invitar a otro da 403 `INVITATION_SHARED_SELF_ONLY`.
2. En cuanto existe al menos una cuenta personal atada de un socio activo, el acceso compartido **no invita a nadie**:
   403 `INVITATION_SHARED_BLOCKED`, "Pídele a un socio con cuenta personal que te invite".
   La cuenta atada de un colaborador no cuenta para esto.
3. Una cuenta personal sí invita a otros socios sin cuenta. Un socio con cuenta atada sigue dando 409.
4. Con un solo socio activo, todo queda como antes: el acceso compartido se invita a sí mismo.

`GET /members/account-status` trae por cada socio `invite: { allowed, reason }`, para que la pantalla muestre el botón
deshabilitado con su explicación. La restricción va antes que el 409.

## Qué no revela

- Si el correo ya es una cuenta, en este negocio o en otro, o si el correo no se pudo enviar, la respuesta es la misma:
  `422 { code: "INVITATION_NOT_SENT", message: "No pudimos enviar la invitación a ese correo." }`.
  No se crea invitación ni se envía nada.
- Un enlace desconocido, usado, reemplazado o vencido da siempre
  `404 { code: "INVITATION_INVALID", message: "Este enlace no sirve. Pide una invitación nueva." }`.
- Límite de intentos en la página pública: 10 por enlace y 120 por dirección cada 10 minutos (429).
- Las respuestas públicas llevan `Cache-Control: no-store` y `Referrer-Policy: no-referrer`.
  En producción, `nginx.conf` pone las mismas cabeceras a la página `/invitacion/`.

## Base de datos

Migración `20261021120000_account_invitations`, aditiva.

- Tabla `AccountInvitation`: hash del token, correo, socio, quién invitó, vencimiento, usada y reemplazada.
- La tabla tiene RLS `tenant_isolation`, con `ENABLE` y sin `FORCE`, a propósito. La ruta pública no tiene sesión y
  debe leer por el hash antes de saber el negocio. El usuario de la API no es el dueño de la tabla, así que sigue atado a la política.
- Dos funciones `SECURITY DEFINER` con `search_path` fijo: `account_invitation_lookup(hash)` y
  `account_invitation_accept(hash, accountId, passwordHash)`.
  - `lookup` devuelve solo `memberName`, `email` y `expiresAt`, y solo si la invitación está vigente.
  - `accept` bloquea la fila (`FOR UPDATE`), crea la cuenta y gasta el enlace. Si dos envíos llegan a la vez, gana uno solo.
  - Ambas ponen el negocio de la invitación mientras leen `Member` (que es `FORCE`) y devuelven el valor anterior de `app.context_id`.
- Prueba: un cliente con el mismo usuario que la API, sin sesión, no ve filas, no escribe y no cambia filas por ninguna otra vía.

## Trazabilidad de aprobaciones

Cada aprobación de reglas guarda en `FinanceRuleApproval.accountOrigin` cómo se creó la cuenta de quien aprobó. El dato se
escribe una vez, junto con la aprobación. No se calcula después.

| `kind` | Significa |
| --- | --- |
| `invited` | Cuenta creada por invitación. Trae quién invitó, cuándo, cuándo se aceptó y `recent` (aceptada 7 días antes de aprobar o menos). |
| `own_account` | Cuenta atada que no vino de una invitación, con su fecha de creación. |
| `invited_from_shared_login` | Cuenta creada por una invitación hecha desde el acceso compartido. No se guarda quién invitó, porque no se puede saber. Siempre entra en el aviso de vigencia, sin importar cuántos días pasaron. |
| `shared_single_partner` | Acceso compartido de un solo socio. |

Las aprobaciones anteriores a este cambio no tienen dato (`origin: null`).
Al pasar una versión a vigente, la vista trae `recentInvitedApprovers`, con quien aprobó con una cuenta invitada hace poco. El panel lo muestra a todos los socios.

## Rutas

| Ruta | Quién | Qué hace |
| --- | --- | --- |
| `POST /members/:id/invitation` | socio | Invita o reenvía. |
| `GET /members/account-status` | socio | Quién tiene cuenta, quién tiene invitación y cuándo se puede reenviar. |
| `POST /invitations/inspect` | público | Consulta a quién va el enlace. No consume. |
| `POST /invitations/accept` | público | Crea la cuenta con la contraseña elegida. |

## Límites conocidos

- Un socio que ya tiene invitación vigente y la rehace con otro correo la reemplaza.
- Quien invita ve que el envío falla cuando el correo ya es una cuenta. Eso no distingue entre "ya existe" y "falló el correo",
  pero un envío exitoso sí se distingue de un fallo. Una respuesta idéntica para todo exigiría aceptar siempre (202).
- El límite de intentos de la página pública está en memoria: se pierde al reiniciar el servidor.

## Dispositivo que se registra al aceptar

Al crear la contraseña, `account_invitation_accept` crea, en el mismo bloque que la cuenta y el enlace gastado, un
dispositivo `activo` llamado "Dispositivo de <nombre del socio>". El servidor genera el token del dispositivo y guarda solo su
SHA-256. La respuesta de `POST /invitations/accept` lo entrega **una sola vez**:

```json
{ "ok": true, "email": "...", "accountId": "...", "device": { "id": "...", "identifier": "...", "name": "Dispositivo de Beto", "token": "..." } }
```

- El token nunca va a registros ni a la base. La respuesta sigue con `no-store` y `no-referrer`.
- El dispositivo aparece en Ajustes → Dispositivos y se revoca como cualquier otro.
- Si dos envíos llegan a la vez, solo uno crea cuenta y dispositivo (el enlace queda bloqueado con `FOR UPDATE`).
- Un enlace que no sirve no crea nada. Un socio con cuenta atada sigue dando 409 al invitarlo.
- Si la persona luego usa otro teléfono, ese teléfono no tiene dispositivo: un socio le da un código desde Ajustes → Dispositivos.

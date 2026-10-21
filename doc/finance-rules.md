# Reglas de reparto (Finanzas)

Las reglas de reparto son un acuerdo escrito entre los socios. Hoy solo se guardan y se aprueban.
Todavía no cambian ningún cálculo: el simulador sigue igual. Un negocio sin reglas funciona como antes.

Es una herramienta de apoyo. No es asesoría contable ni legal. Conviene validar las reglas con un contador.

## Quién puede usarlas

Solo los socios activos. Un colaborador recibe 403 en todas las rutas de la app. Las rutas están en la
matriz de permisos (`test/impersonation-matrix.e2e-spec.ts`). La página pública no usa sesión: la protege
el enlace de cada socio.

## Qué contiene una versión

Una configuración con `schemaVersion: 1` y siete bloques. El servidor la valida (`finance-rules.config.ts`).

| Bloque | Campos |
| --- | --- |
| `profitBase` | `partnerPct`, `capitalPct`, `workPct`. Deben sumar 100. |
| `reinvestment` | `currentPhase` (arranque, operacion, cierre), un % por fase y `untilAmountMinor` (monto o `null`). |
| `capitalRecovery` | `mode` (ninguna, por_diferencia, total, proporcional) y `timing` (durante, al_cierre). |
| `work` | `payHours`, `order` (antes, despues) y `pay` (por hora en centavos, o un %). |
| `partnerExpenses` | no_reembolsar, reembolsar, contar_como_aportacion. |
| `reserves` | un % o un monto fijo en centavos. |
| `partnerLoans` | `repayBeforeCapital`. |

La única restricción dura es que la base de utilidad sume 100. Porcentajes de 0 a 100, con hasta dos
decimales. Todo lo demás se acepta. Si algo es raro, la respuesta trae `warnings` con una explicación
corta. Un aviso nunca impide guardar.

## Cómo se aprueba: por correo

Aprobar siempre es por correo, incluso con un solo socio. En la app no hay botones de aprobar. Una
tablet compartida no prueba quién es la persona; un correo sí prueba quién tiene el buzón.

1. Cualquier socio escribe un borrador y lo envía. Solo quien lo creó lo edita y lo envía.
2. A **cada** socio activo, incluido quien propuso, le llega un correo con el resumen de las reglas en
   palabras sencillas y el botón "Revisar y responder". Cada uno recibe **su propio enlace**.
3. El botón abre `/acuerdo/<token>`, una página pública con las reglas completas y dos botones:
   **Aprobar** y **No estoy de acuerdo** (con un motivo obligatorio).
4. Aprueba el último socio activo y la versión pasa a `vigente`. La anterior pasa a `reemplazada`.

Si a algún socio le falta el correo, la propuesta no se envía. La respuesta es 422
`FINANCE_RULES_MISSING_EMAIL` y dice a quién le falta.

### El enlace

- Un token de 256 bits, de un solo uso. Solo se guarda su SHA-256 (`FinanceRuleLink.tokenHash`).
- Dura 7 días. Un enlace que caduca deja la propuesta pendiente: cualquier socio puede reenviar.
- **Abrir el enlace no consume nada.** La página lee con `POST /agreements/inspect`. Responder es otro
  `POST /agreements/respond`. No existe ningún `GET`, porque los escáneres de correo abren los enlaces.
- Las respuestas llevan `Cache-Control: no-store` y `Referrer-Policy: no-referrer`. En producción nginx
  manda las mismas cabeceras en `/acuerdo/` (`nginx.conf`).
- Desconocido, usado, reemplazado, vencido, de un socio dado de baja o de una propuesta cerrada:
  **la misma respuesta** (404 `AGREEMENT_LINK_INVALID`). Nada revela cuál es el motivo.
- Límite de intentos: 10 por enlace y 120 por dirección cada 10 minutos (429).
- El token no aparece en ningún registro. Una prueba lo comprueba.
- Los correos de aprobación usan el envío simple de Resend, **sin** el respaldo al operador que usan los
  correos de credenciales. Reenviar al operador un enlace de aprobación dejaría que otra persona responda
  por el socio.

### "No estoy de acuerdo"

- Pide un motivo: de 1 a 500 letras, texto plano. Sin motivo no se registra nada.
- La propuesta pasa a `en_revision`. **No se manda ningún correo.** El estado y los motivos se ven en la app.
- Los enlaces de los demás socios dejan de aceptar aprobaciones y muestran: "Esta propuesta está en
  revisión; recibirás la versión nueva por correo."
- Las objeciones no se pueden cambiar ni borrar (trigger).

### Reenviar

`POST /finance/rules/:id/resend`: crea un enlace nuevo solo para quienes faltan y anula el anterior de
cada uno. Máximo un reenvío por socio cada 24 horas. Un reenvío cuyo correo falló no cuenta. Cualquier
socio puede reenviar. En revisión no se reenvía.

### Modificar y descartar

- **Modificar** (`POST /finance/rules/:id/modify`): copia una propuesta abierta en un borrador de quien lo
  pide, con las objeciones a la vista. La propuesta original sigue como está hasta que se envíe la nueva.
- Al enviar la versión nueva: correo a **todos**, con la sección "Qué cambió" (antes y ahora de cada
  tema), y todos aprueban de nuevo. Las aprobaciones anteriores no se arrastran. La versión vieja queda
  `descartada` con la nota "Reemplazada por la versión N."
- "Qué cambió" compara con la versión de la que se copió o, si es una propuesta nueva, con las reglas vigentes.
- **Descartar** (`POST /finance/rules/:id/discard`): cualquier socio, sobre un borrador o una propuesta
  abierta. Queda `descartada` en el historial, con quién la descartó.
- "Retirar" ya no existe. Mientras tanto siguen valiendo las reglas vigentes.

## Ciclo de vida

```
borrador ──enviar──▶ pendiente ──aprueba el último socio──▶ vigente ──otra vigente──▶ reemplazada
   │                    │
   │                    └──un socio objeta──▶ en_revision
   │                                              │
   └───────────── descartar (cualquier socio) ────┴──▶ descartada
```

- Hay un solo borrador y una sola propuesta abierta (pendiente o en revisión) por negocio.
- Al enviar, la versión queda inmutable. Un trigger de la base lo impide, incluso con SQL directo.
- Las versiones son consecutivas por negocio. Se numeran dentro de la transacción de creación.
- `retirada` solo existe en filas anteriores. Ya no se genera.

### El último en aprobar

La función SQL `finance_rule_link_respond` bloquea primero la propuesta y después el enlace. La app
bloquea en el mismo orden, así que no hay bloqueos cruzados. Con tres respuestas al mismo tiempo, la
versión queda vigente exactamente una vez y la anterior queda reemplazada una sola vez (hay prueba de
concurrencia). Responder dos veces el mismo enlace al mismo tiempo registra una sola respuesta.

Un socio dado de baja deja de contar y su enlace deja de servir. Si con eso ya están todas las
respuestas, la versión se activa cuando alguien reenvía (`finance_rule_set_settle`).

## El correo de cada socio

La aprobación va a `Member.correo`: un solo correo por persona, único entre todos los negocios y siempre
en minúsculas. Es independiente del login.

- Quien se agrega con `POST /members` lo trae de su correo. Uno que ya está en uso da 409
  `MEMBER_EMAIL_IN_USE` ("Ese correo ya está en uso. Usa otro correo.") y no crea nada.
- La migración rellena el de las cuentas personales que ya existían y, en un negocio con un solo socio,
  el correo que el fundador confirmó al registrarse.
- Quien no lo tiene lo escribe **una vez** en la app (`PUT /members/me/email`) y lo confirma con un enlace
  enviado a ese correo. Hasta que lo abre, no cambia nada. El correo nunca se ve completo en pantalla.
- Solo se escribe el propio. No existe ninguna ruta para escribir el de otra persona.
- Al confirmarse, los otros socios reciben un aviso con el nombre y el correo enmascarado.
- Límite: 5 correos de confirmación por hora por persona.
- Las cuentas con un usuario inventado (sin correo) quedan en "falta correo" hasta que el socio escriba el suyo.

## Historial

Cada respuesta guarda el correo completo en la base, la fecha y, si objetó, el motivo. En pantalla el
correo sale enmascarado (`a***@e***.com`). Cada aprobación guarda el hash exacto de lo aprobado y la
base rechaza una aprobación con otro hash. Las aprobaciones hechas antes desde una sesión se muestran
sin correo (`via: "sesion"`).

## Rutas

| Ruta | Qué hace |
| --- | --- |
| `GET /finance/rules` | Estado, vigentes, propuesta abierta, borrador, historial, socios con su respuesta y mi correo. |
| `PUT /finance/rules/draft` | Crea o reemplaza el borrador. Cuerpo: `{ "config": {...} }`. |
| `POST /finance/rules/:id/submit` | Envía el borrador: un correo con enlace propio a cada socio. |
| `POST /finance/rules/:id/resend` | Reenvía a quien falta. |
| `POST /finance/rules/:id/modify` | Copia una propuesta abierta en un borrador. |
| `POST /finance/rules/:id/discard` | Descarta un borrador o una propuesta abierta. |
| `GET /members/me/email` | Mi correo (enmascarado) y la confirmación pendiente. |
| `PUT /members/me/email` | Pide confirmar un correo nuevo. Cuerpo: `{ "correo": "..." }`. |
| `POST /agreements/inspect` | Pública. Muestra la propuesta de un enlace. No consume. |
| `POST /agreements/respond` | Pública. `{ token, decision: "approve" \| "object", reason? }`. |
| `POST /member-emails/inspect` | Pública. Muestra qué correo se va a confirmar. No consume. |
| `POST /member-emails/confirm` | Pública. Confirma el correo, una sola vez. |

Se quitaron `POST /finance/rules/:id/approve`, `/withdraw` y `/remind`.

## Datos

Migraciones `20261024120000_rules_approval_by_email` y `20261024120500_member_correo_taken`, aditivas:

- `Member.correo` (único, minúsculas).
- `FinanceRuleLink` (un enlace por socio y propuesta), `FinanceRuleObjection` (inmutable) y
  `MemberEmailConfirmation`.
- `FinanceRuleSet`: estados `en_revision` y `descartada`, y las columnas `basedOnId`, `changeSummary`,
  `inReviewAt`, `discardedAt` y `closedNote`.
- `FinanceRuleApproval`: `approvedByAccountId` ya puede ser nulo (no hay cuenta detrás de un correo), más
  `correo` y `linkId`.
- Funciones SQL `finance_rule_link_lookup`, `finance_rule_link_respond`, `finance_rule_set_settle`,
  `member_email_confirmation_lookup`, `member_email_confirm` y `member_correo_taken`.
- Las tablas de enlaces y confirmaciones tienen RLS sin FORCE a propósito: la página pública busca por el
  hash del token antes de saber de qué negocio es. El rol de la API no es dueño de las tablas, así que la
  política sí lo limita. `FinanceRuleObjection` sí tiene FORCE.

Las propuestas que esperaban aprobación con el mecanismo anterior (desde una sesión) se marcaron como
`descartada`, con la nota "Se descartó porque ahora las reglas se aprueban por correo. Propónganlas de
nuevo." Sus aprobaciones se conservan como historial.

## Límites conocidos

- Quien escribe su correo en una tablet compartida no prueba quién es: el enlace prueba que controla ese
  buzón, no que sea la persona elegida. Por eso solo se puede escribir una vez, queda registrado quién lo
  pidió, y los otros socios reciben el aviso. Cambiarlo después será un paso aparte.
- `FinanceRuleReminder` ya no se usa. La tabla se conserva por ahora.

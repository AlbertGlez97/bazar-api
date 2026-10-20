# Reglas de reparto (Finanzas, fase 1)

Las reglas de reparto son un acuerdo escrito entre los socios. Fase 1 solo las guarda y las aprueba.
Todavía no cambian ningún cálculo: el simulador sigue igual. Un negocio sin reglas funciona como antes.

Es una herramienta de apoyo. No es asesoría contable ni legal. Conviene validar las reglas con un contador.

## Quién puede usarlas

Solo los socios activos. Un colaborador recibe 403 en todas las rutas. Las rutas están en la matriz de
permisos (`test/impersonation-matrix.e2e-spec.ts`).

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

La fase actual del negocio está dentro de la configuración. Cambiarla es una versión nueva y la aprueban todos.

## Ciclo de vida

```
borrador ──enviar──▶ pendiente ──aprueba el último socio──▶ vigente ──otra versión vigente──▶ reemplazada
   │  ▲                  │
   │  └────── retirar ───┘   (borra las aprobaciones)
   └─ descartar ─▶ retirada
```

- Hay un solo borrador y una sola propuesta pendiente por negocio.
- El borrador es del socio que lo creó. Solo esa persona lo edita, lo envía, lo descarta, lo retira o manda recordatorios.
- Al enviar, la versión queda inmutable. Un trigger de la base lo impide, incluso con SQL directo.
- Las versiones son consecutivas por negocio. Se numeran dentro de la transacción de creación.
- Retirar una propuesta pendiente la regresa a borrador y borra sus aprobaciones.
- Mientras una versión nueva está pendiente, siguen valiendo las reglas vigentes.

## Aprobación

- Aprueban todos los socios activos. Un socio dado de baja deja de contar. Un socio nuevo debe aprobar.
- Aprueba solo quien tenga una cuenta atada a su socio (`account.memberId === x-member-id`).
- Excepción: si el negocio tiene un solo socio activo, su acceso compartido sí puede aprobar.
- Con acceso compartido y más de un socio, la respuesta es 403 `FINANCE_RULES_SHARED_LOGIN`. Trae un mensaje
  claro en español. `GET /finance/rules` ya lo avisa en `me.canApprove` y `me.cannotApproveReason`.
- El último en aprobar activa la versión. La anterior pasa a `reemplazada`. Un candado de fila hace que
  ocurra exactamente una vez, aunque dos aprueben al mismo tiempo.
- Aprobar dos veces no cambia nada. Repetir la aprobación también revisa si ya faltan menos socios.
- Cada aprobación guarda el hash exacto de lo aprobado. La base rechaza una aprobación con otro hash.

## Recordatorios

El proponente avisa a quien falta: correo (Resend) y aviso en la app (`me.reminderReceivedAt`).
Máximo uno por socio cada 24 horas. Si el correo falla, el aviso en la app queda igual.
El correo solo se envía si el usuario de la cuenta del socio es un correo.

## Rutas

| Ruta | Qué hace |
| --- | --- |
| `GET /finance/rules` | Estado, vigentes, pendiente, borrador, historial y permisos de quien consulta. |
| `PUT /finance/rules/draft` | Crea o reemplaza el borrador. Cuerpo: `{ "config": {...} }`. |
| `POST /finance/rules/:id/discard` | Descarta un borrador (`retirada`). |
| `POST /finance/rules/:id/submit` | Envía el borrador a aprobación. |
| `POST /finance/rules/:id/withdraw` | Retira una propuesta pendiente. |
| `POST /finance/rules/:id/approve` | Aprueba. |
| `POST /finance/rules/:id/remind` | Recuerda a quien falta. |

## Datos

Migración `20261020120000_finance_rule_sets`, solo aditiva: `FinanceRuleSet`, `FinanceRuleApproval` y
`FinanceRuleReminder`. Las tres tienen RLS `tenant_isolation` con FORCE, como el resto de Finanzas.
Los índices únicos parciales garantizan una sola versión vigente y una sola pendiente por negocio.

## Límites conocidos

- Si un socio se da de baja y con eso ya están todas las aprobaciones, la versión se activa cuando
  alguien vuelva a pulsar aprobar. La consulta no escribe.
- Mientras un socio use el acceso compartido y haya más de uno, no puede aprobar. Falta crear cuentas
  personales para socios existentes (propuesta F1b, aún sin programar).

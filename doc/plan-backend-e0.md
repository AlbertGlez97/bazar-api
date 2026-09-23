# Plan del backend E0: primera venta funcional

**Resultado buscado:** una API que registre productos y ventas de varios artículos, descuente existencias de forma consistente y reciba ventas realizadas sin conexión sin duplicarlas. Empezaremos por el backend; la interfaz se integrará después.

**Estado:** documento de planificación. No se implementaron módulos, no se instalaron dependencias y no se ejecutaron pruebas al redactarlo. La estructura, contratos y tecnologías nuevas son **PROPUESTOS** hasta su aprobación y validación.

**Fuentes de alcance:** [contexto original](contexto-y-reglas-de-negocio-bazar.txt), [guía incremental](reglas-de-negocio-y-desarrollo-incremental.md) y decisiones posteriores del usuario recogidas aquí. **La definición vigente de E0 es la primera venta funcional**; la antigua secuencia E0–E7 queda como referencia general, no como numeración de este plan.

## 1. Alcance confirmado para esta entrega

| Tema | Decisión vigente |
| --- | --- |
| Producto | Campo `tipo` con valores `unica` o `cantidad`. Una pieza única comienza con existencia 1 y pasa a 0 al venderse; no se agrega un estado «vendido». |
| Datos obligatorios | Nombre, tipo, precio de venta y existencia inicial. |
| Datos opcionales | Foto, categoría, costo de compra, proveedor y notas. Su representación técnica todavía se propone. |
| Dinero | MXN con dos decimales. La representación interna en centavos todavía no está aprobada. |
| Preparación del equipo | Inicio de sesión online al menos una vez, catálogo descargado y nombre del dispositivo. |
| Persona que atiende | Selector de socios preexistentes en tablet/teléfono compartidos; sin PIN ni reautenticación por venta. Cualquier socio puede vender. |
| Venta | Búsqueda por nombre, varios productos y cantidades, efectivo y cálculo de cambio. Descuentos y cancelaciones bloqueados en E0. |
| Registro | Fecha/hora, productos, cantidades, precios efectivamente cobrados, socio y dispositivo. |
| Desconexión | Venta guardada en cola local y enviada al reconectar; los reenvíos no duplican sus efectos. |

Quedan fuera de **esta entrega**, no del MVP completo: QR, descuentos, cancelaciones, apartados, reservas, mermas, gastos, reintegros, jornadas y cierre de evento. No se construirán microservicios, un motor genérico de sincronización ni una plataforma de pagos.

La fila de stock cero en gris corresponde al frontend: una respuesta de API con existencia 0 no demuestra ese comportamiento visual. La captura/upload de fotos requiere un contrato y almacenamiento propios; no se presupone un proveedor.

## 2. Punto de partida verificado en el repositorio

Inspección de `package.json`, `package-lock.json`, paquetes locales, `tsconfig*.json`, configuraciones de Vitest y archivos actuales de `src/` y `test/`:

| Tecnología/configuración existente | Evidencia observada |
| --- | --- |
| NestJS + adaptador Express | `@nestjs/core` y `@nestjs/platform-express` 12.0.4 en lockfile y paquetes locales; los rangos declarados son `^12.0.1`. |
| TypeScript y ESM | TypeScript 6.0.3 instalado; `type: module`, resolución `nodenext`, destino ES2023 y modo `strict`. |
| Pruebas | Vitest 4.1.11 y Supertest 7.3.0 instalados; configuraciones separadas para `*.spec.ts` y `*.e2e-spec.ts`. |
| Calidad | Oxlint 1.85.0 y Prettier 3.9.8 instalados; existen scripts de lint, formato y cobertura. |
| Aplicación | `AppModule` sin módulos importados; controlador/servicio de ejemplo con `GET /` → `Hello World!`. Las pruebas actuales comprueban ese ejemplo. |
| Persistencia y acceso | No hay modelos, módulos de negocio ni paquetes directos de base de datos, ORM, validación DTO o autenticación en `package.json`. |

La presencia de herramientas no demuestra que los checks pasen. Tampoco activa TDD: **el modo TDD no está determinado** y debe confirmarse antes de implementar. No se deduce la versión de Node a partir de `@types/node`.

## 3. Tecnologías recomendadas

Conservar lo existente y agregar **una sola combinación propuesta: PostgreSQL + Prisma**, validación con DTO y autenticación de NestJS. No se fija una versión de componentes aún no instalados.

| Pieza | Propuesta y razón | Costo o validación necesaria |
| --- | --- | --- |
| Servidor y lenguaje | Mantener NestJS, Express, TypeScript y ESM. | Confirmar el runtime Node y compatibilidad del conjunto antes de agregar paquetes. |
| Base central | PostgreSQL: relaciones y transacciones para venta, líneas y existencias. | Requiere servicio local/de pruebas, migraciones y respaldo; no equivale a almacenamiento offline del navegador. |
| Acceso a datos | Prisma, cliente generado y migraciones; adaptador PostgreSQL requerido por la versión seleccionada. | Agrega generación de cliente y configuración. Validar su versión compatible; no copiar APIs de otra versión ni prometer compatibilidad ya comprobada. |
| Contratos de entrada | `ValidationPipe` con `class-validator` y `class-transformer`; DTO explícitos y rechazo de campos no admitidos. | Los DTO validan forma, no sustituyen reglas de negocio ni restricciones de la base. |
| Autenticación | `@nestjs/jwt`, guard de autenticación y credenciales con hash seguro; no añadir Passport si no se necesita. | Aprobar ciclo de sesión, renovación y revocación; seleccionar librería de hash compatible, sin contraseñas en texto plano. |
| Comprobaciones | Mantener Vitest y Supertest; integración contra PostgreSQL aislado. | Los mocks no demuestran atomicidad ni carreras reales. No se agrega un segundo runner. |

PostgreSQL documenta el comportamiento todo-o-nada de las transacciones. La elección para este proyecto es una recomendación, no una decisión de la fuente. [Transacciones de PostgreSQL](https://www.postgresql.org/docs/current/tutorial-transactions.html).

NestJS documenta su integración con Prisma, y Prisma trata transacciones e idempotencia. Se validará la API correspondiente a la versión elegida; este plan no prescribe llamadas específicas. [Integración NestJS–Prisma](https://docs.nestjs.com/recipes/prisma), [transacciones e idempotencia en Prisma ORM v7, referencia conceptual](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions).

La validación DTO y JWT tienen guías oficiales; adoptarlos exige configuración y pruebas, no solo instalar paquetes. [Validación NestJS](https://docs.nestjs.com/techniques/validation), [autenticación NestJS](https://docs.nestjs.com/security/authentication).

## 4. Estructura propuesta: módulos aún no creados

`src/main.ts` y `src/app.module.ts` ya existen; el resto de módulos y archivos específicos que se muestra a continuación se propone crear gradualmente.

```text
src/
  main.ts
  app.module.ts
  database/
    database.module.ts
    database.service.ts
  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    auth.guard.ts
    dto/
  members/
    members.module.ts
    members.controller.ts
    members.service.ts
  devices/
    devices.module.ts
    devices.controller.ts
    devices.service.ts
    dto/
  products/
    products.module.ts
    products.controller.ts
    products.service.ts
    dto/
  sales/
    sales.module.ts
    sales.controller.ts
    sales.service.ts
    dto/
    sales.service.spec.ts
prisma/
  schema.prisma
  migrations/
test/
  products.e2e-spec.ts
  sales.e2e-spec.ts
```

Cada módulo se crea cuando lo requiere su tarea; este árbol no es una instrucción para generar carpetas vacías. Las demás pruebas unitarias vivirán junto al módulo correspondiente.

- **Auth:** autentica la cuenta y valida el contexto de sesión; una cuenta no se reemplaza por el nombre del socio seleccionado.
- **Members:** expone socios preexistentes seleccionables; no incorpora compensaciones, roles complejos ni altas públicas.
- **Devices:** registra nombre e identidad del equipo y comprueba su autorización.
- **Products:** alta, búsqueda, catálogo y existencias; no agrega estados de venta redundantes.
- **Sales:** orquesta registro, validaciones, idempotencia y transacción. Todas las escrituras de una venta deben compartir la misma transacción, incluso si colaboran otros servicios.
- **Database:** conexión y acceso persistente. No introduce repositorios genéricos ni capas adicionales sin necesidad.

Dependencias: `auth → members/devices autorizados → products → sales`. La identidad de cuenta es un prerrequisito de seguridad; no se trata de un sexto dominio comercial. No hay módulo `sync` en E0: recibir una venta pendiente utiliza el mismo contrato de venta.

## 5. Modelo mínimo propuesto

Los nombres técnicos en inglés son propuestas, excepto el campo `tipo` especificado por el usuario; sus valores confirmados se mantienen `unica | cantidad`.

| Modelo | Datos y responsabilidad |
| --- | --- |
| `Account` | Identidad de acceso, credencial protegida y vínculo con socio; autenticación inicial. Aprovisionamiento controlado pendiente, no registro público implícito. |
| `Member` | Identidad y nombre del socio preexistente. La selección determina atribución, no autentica de nuevo a la persona. |
| `Device` | Identidad estable, nombre y asociación/autorización de acceso. Su ID en el cuerpo no basta para autorizarlo. |
| `Product` | ID, `name`, `tipo`, `salePriceMinor`, `initialStock`, `stock`; opcionales `photo`, `category`, `purchaseCostMinor`, `supplier`, `notes`. La forma de `photo` queda pendiente. |
| `Sale` | UUID persistente generado por el cliente con restricción única, socio, dispositivo, cuenta autenticada, fecha de ocurrencia/recepción, moneda, total, efectivo, cambio y datos normalizados necesarios para comparar reenvíos. |
| `SaleItem` | Venta, producto, cantidad y precio cobrado conservado históricamente; subtotal calculado. No depende del precio actual para reconstruir el cobro. |

**Dinero propuesto:** enteros en centavos en persistencia y contrato (`...Minor`), moneda `MXN`; por ejemplo 12550 representa 125.50 MXN. Totales calculados en el servidor, sin confiar en un total enviado. Se deben definir límites para evitar desbordamientos. Rechazar o redondear entradas con más de dos decimales sigue pendiente.

**Existencias:** piezas únicas solo se crean con 1 y se venden con cantidad 1; los productos por cantidad descuentan las unidades vendidas. Se propone validar cantidades enteras positivas y existencias enteras no negativas, sujeto a aprobación del tratamiento de insuficiencia/concurrencia. `initialStock` no debe convertirse en una vía de ajuste posterior encubierta.

**Fechas propuestas:** `occurredAt` conserva el instante declarado por el equipo, con zona/offset; `receivedAt` se asigna en servidor. Conservar ambos no implica que el reloj del dispositivo sea confiable; desfases admitidos y fecha comercial quedan por definir.

## 6. Contratos HTTP propuestos

Todas las rutas comerciales requieren acceso autorizado. No se implementan descuentos, cancelaciones ni modificación genérica de ventas.

| Ruta | Entrada o salida principal |
| --- | --- |
| `POST /auth/login` | Credenciales → sesión/token; duración, renovación y vinculación al dispositivo pendientes. |
| `GET /members` | Socios que puede seleccionar el contexto autenticado. |
| `POST /devices` | Nombre del equipo → identidad registrada; definir recuperación para no registrar otro dispositivo con cada reintento. |
| `POST /products` | Campos obligatorios/opcionales aprobados → producto con existencia inicial. Permiso de alta pendiente: «todos pueden vender» no lo concede. |
| `GET /products?search=...` | Búsqueda por nombre; sin búsqueda, catálogo descargable con stock/precio. Definir paginación completa o snapshot coherente antes de integrar la descarga. |
| `POST /sales` | `id`, `memberId`, `deviceId`, `occurredAt`, `currency`, `cashReceivedMinor`, `items[{productId, quantity, unitPriceMinor}]` → venta persistida, total y cambio. |
| `GET /sales/:id` | Resultado de una venta accesible para ese contexto, útil para recuperar una confirmación perdida. |

Validar arrays no vacíos, identificadores, límites y campos inesperados. Definir normalización de artículos repetidos y orden del payload antes de comparar reintentos. Precio recibido no significa descuento autorizado: la comparación con el catálogo y los precios offline desactualizados dependen de la política pendiente.

**Respuestas propuestas:** 201 para creación; 200 con el resultado original para repetición equivalente; 400 por forma inválida; 401/403 por acceso; 409 si el mismo ID trae otro contenido. Los conflictos de stock/precio tendrán código estable y política acordada, sin declararlos resueltos como una simple elección HTTP.

## 7. Registro consistente e idempotente

Este algoritmo es **PROPUESTO** para cumplir la prevención de duplicados confirmada:

1. Autenticar y autorizar cuenta, equipo y socio seleccionable; validar estructura. No confiar en identidades aportadas libremente por el cliente.
2. Buscar la identidad persistente de venta dentro del ámbito autorizado. Si ya está confirmada y el payload normalizado coincide, devolver su resultado **antes de volver a validar precio/stock actuales**. Si difiere, responder conflicto sin modificar nada.
3. Para una venta nueva, resolver precios, efectivo y disponibilidad según las políticas aprobadas; calcular subtotales, total y cambio. Las lecturas/validaciones mutables decisivas deben quedar protegidas dentro de la misma transacción que las escrituras, no depender de una consulta previa desactualizada.
4. Dentro de una única transacción, registrar identidad única, cabecera y líneas, y modificar todas las existencias necesarias. Un fallo revierte toda la venta; no dejar artículos descontados parcialmente.
5. Proteger también las escrituras concurrentes con restricciones únicas y estrategia transaccional de bloqueo/actualización condicional o aislamiento acordada técnicamente. Un `find` antes de `create` no es protección suficiente.
6. Si dos solicitudes simultáneas reutilizan el mismo ID, recuperar el resultado persistido al resolverse la carrera, comparar payload y aplicar el mismo criterio de repetición/conflicto. Los reintentos técnicos deben ser acotados.
7. Confirmar al cliente solo después del commit. Si se pierde la respuesta, reenviar el mismo ID recupera el mismo resultado, sin una segunda resta.

La transacción mantiene consistencia del servidor; **no decide qué hacer con dos ventas offline diferentes sobre la última pieza**. No se aprueba «la primera que llega gana», stock negativo ni eliminación de la segunda venta. Ese caso bloquea la puesta en operación hasta decidir su tratamiento.

## 8. Límite entre backend y frontend offline

| Backend de E0 | Frontend posterior |
| --- | --- |
| Login online, identidad de equipo y socios permitidos. | Preparación del dispositivo y selector de socios, sin PIN por venta. |
| Catálogo descargable y contratos de precios/existencias. | Catálogo local, búsqueda sin red y presentación gris de existencia cero. |
| Recepción idempotente, validación, transacción y consulta del resultado. | ID generado una sola vez por venta, outbox persistente, reintentos y retirada de pendientes solo tras confirmación. |
| Errores/conflictos explícitos y comprobables. | Mostrar pendientes/conflictos y conservar la operación cuando no haya resolución. |

La cola local no es una entidad obligatoria del backend. Sin frontend aún no puede demostrarse una venta real desconectada: sí puede probarse la recepción posterior del mismo payload, incluso después de reiniciar el servidor.

## 9. Plan de trabajo propuesto

No hay tareas completadas por haber escrito este documento. Cada tarea entrega un resultado comprobable y evita construir dominios futuros.

| ID | Tarea | Depende de | Evidencia de aceptación |
| --- | --- | --- | --- |
| BE-01 | [ ] Aprobar stack y políticas que afecten la primera venta; fijar contratos y modo TDD. | — | Decisiones explícitas; no suponer permisos, precios offline ni ganadores de conflictos. |
| BE-02 | [ ] Validar versiones/runtime y preparar persistencia, migraciones y base aislada. | BE-01 | Conexión y migración reproducibles; build y checks base registrados. |
| BE-03 | [ ] Implementar cuentas, acceso, socios preexistentes y dispositivos. | BE-02 | Acceso válido funciona; credenciales inválidas y atribución a contexto no autorizado fallan; no registrar usuarios públicos implícitamente. |
| BE-04 | [ ] Implementar alta, listado/búsqueda y descarga de productos. | BE-03 | Campos mínimos obligatorios, opcionales ausentes válidos; única inicia en 1; catálogo contiene únicos y repetidos. |
| BE-05 | [ ] Implementar venta multiartículo, dinero, atribución y transacción. | BE-04 | Totales/cambio correctos, única 1→0, dos unidades descontadas; fallo intermedio revierte todos los artículos. |
| BE-06 | [ ] Completar reenvíos simultáneos, confirmación perdida y conflictos. | BE-05 | Misma venta no duplica efectos ni tras reinicio; payload distinto con mismo ID falla; política aprobada de última pieza comprobada. |
| BE-07 | [ ] Ejecutar aceptación integrada y documentar contrato para frontend. | BE-06 | Checks con resultados reales; límites offline/UI explícitos; sin declarar terminado el MVP completo. |

## 10. Pruebas y comandos existentes

Escenarios propuestos: crear única y cantidad; vender una única más dos unidades con total y cambio esperados; conservar precios cobrados y actor/equipo; devolver el resultado original aunque ahora el stock sea cero; repetir simultáneamente el mismo ID; reutilizar ID con otro contenido; rollback al fallar una línea; persistencia tras reinicio; acceso no autorizado; intento de descuento/cancelación bloqueado.

Efectivo insuficiente, precio desactualizado, más de dos decimales y dos ventas diferentes de la última pieza requieren primero una decisión: la prueba no puede inventar su resultado. Los importes concretos de los fixtures serán ilustrativos, no precios del negocio.

| Comando existente | Propósito al implementar |
| --- | --- |
| `npm test` | Unitarias y demás archivos `*.spec.ts`; comprobar reglas sin depender de la interfaz. |
| `npm run test:e2e` | Contratos HTTP `*.e2e-spec.ts`; agregar escenarios reales con base aislada. |
| `npm run test:cov` | Medir cobertura como diagnóstico, no como sustituto de escenarios críticos. |
| `npm run lint` | Oxlint con comprobación de tipos sobre `src/` y `test/`. |
| `npm run build` | Compilar la aplicación NestJS. |

`npm run format` modifica archivos: usarlo antes de la verificación final, no presentarlo como un check de solo lectura. No hay un script separado `test:integration`; no se debe afirmar que existe. Si TDD se acuerda, exigir RED → GREEN → REFACTOR observable; si no, mantener las comprobaciones funcionales.

## 11. Decisiones pendientes y siguiente paso

- [ ] Aprobar PostgreSQL + Prisma, validación DTO, JWT y representación en centavos; validar versiones compatibles y el runtime antes de instalar.
- [ ] Decidir ventas offline distintas sobre la última pieza y falta de existencias, sin convertir una carrera técnica en política de negocio.
- [ ] Resolver precios del catálogo desactualizados frente a «sin descuentos», efectivo insuficiente y entradas de más de dos decimales.
- [ ] Definir aprovisionamiento de cuentas/socios, permiso de alta de productos, asociación de equipo, sesiones offline, renovación/revocación y límites de acceso.
- [ ] Cerrar descarga del catálogo, representación opcional de foto, límites de cantidades/importes y fechas; confirmar TDD.

**Siguiente paso:** revisar BE-01 y aprobar las decisiones necesarias. La autorización actual cubre este plan documental, no instalaciones ni implementación. Las decisiones aún abiertas no impiden revisar contratos, pero sí impiden afirmar que el backend está listo para operar.

# Bazar: reglas de negocio y desarrollo incremental

**Objetivo:** construir poco a poco una herramienta para vender y administrar el bazar desde una tablet compartida y teléfonos, incluso sin internet, sin perder trazabilidad ni inventar políticas del negocio.

**Fuente:** [Contexto y reglas de negocio, versión 1.0](contexto-y-reglas-de-negocio-bazar.txt), consolidada el 22 de septiembre de 2026. Los identificadores de este documento remiten a esa fuente.

**Alcance de este documento:** organiza requisitos y propone una ruta de trabajo. No prueba que existan funciones implementadas, no cierra el diseño técnico y no autoriza por sí mismo la implementación de las etapas.

## 1. Cómo usar esta guía

1. Revisar las reglas confirmadas y resolver únicamente las decisiones que bloqueen la siguiente entrega.
2. Aprobar el alcance de una entrega pequeña, completa y verificable.
3. Construirla, demostrar sus escenarios y registrar resultados antes de avanzar.

| Estado | Significado |
| --- | --- |
| **CONFIRMADO** | Necesidad o elección aceptada en la fuente; la metodología incremental también fue solicitada expresamente por el usuario. |
| **PROPUESTO** | Recomendación todavía sujeta a aprobación; incluye la secuencia y los criterios nuevos de esta guía. |
| **PENDIENTE** | Decisión de negocio o técnica que no debe sustituirse por una suposición. |

Las cifras ilustrativas de la fuente no fijan precios, salarios, porcentajes, moneda ni capital inicial. Los pendientes no eliminan funciones del MVP: impiden cerrar su comportamiento sin una decisión.

## 2. Alcance confirmado y límites

El catálogo no se limita a bonsáis. Debe representar piezas únicas y productos equivalentes por cantidad. Los dos socios pueden aportar dinero y trabajar tiempos distintos; también habrá apoyo ocasional de familiares.

El MVP completo conserva:

- Ventas con varios productos, cobro conjunto, cálculo de cambio, QR y búsqueda por nombre.
- Precios ajustables con registro del ajuste, cancelaciones y movimientos inversos de inventario.
- Productos únicos y repetidos, fotos, historial, entradas rápidas y mermas.
- Reservas internas y apartados con anticipo, aunque sus políticas estén pendientes.
- Gastos por pagador, porción empresarial/personal, reintegros y aportaciones individuales.
- Cuentas personales, identificación de quien atiende y del dispositivo, jornadas y colaboradores.
- Notas del día y cierre del evento con ventas, gastos, utilidad, horas y productos vendidos.
- Operación offline y multidispositivo desde la base, no como una fase opcional posterior.

**No comprometido para el arranque:** predicción, fidelización, tickets personalizados, WhatsApp, sucursales, IA, estadísticas avanzadas, microservicios, gestión completa de proveedores, alertas de stock y análisis avanzado de antigüedad. Una terminal del sistema en el teléfono no equivale a una terminal bancaria. Referencia: secciones 3 y 13 de la fuente.

## 3. Reglas de negocio por dominio

### 3.1 Venta y cobro

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Una venta admite varios productos y cantidades con un cobro conjunto; se busca por QR o nombre. `VEN-01`, `VEN-02`. |
| CONFIRMADO | La venta normal permite consultar precio y registrar cobro sin exigir ticket ni datos del cliente. `PR-02`, `VEN-03`. |
| CONFIRMADO | Para efectivo, cambio = efectivo recibido − total. El precio aplicado puede modificarse conservando el descuento o ajuste frente al precio de referencia. `VEN-04`, `VEN-07`. |
| CONFIRMADO | Se admiten cancelaciones por error, devolución o desistimiento; se prevé devolver inventario conforme a la resolución. No se ha definido el tratamiento de devoluciones dañadas o parciales. `VEN-08`, `INV-02`. |
| PROPUESTO | Cálculo opcional del cambio; no liquidar una venta normal con efectivo insuficiente. Registrar efectivo, transferencia o tarjeta sin afirmar que el sistema procesa o verifica pagos bancarios. `VEN-05`, `VEN-06`. |
| PROPUESTO | Guardar fecha, hora, productos, cantidades, precios cobrados, método de pago, persona y dispositivo. `VEN-09`. |
| PENDIENTE | Facultades para descuentos/cancelaciones/devoluciones, motivos obligatorios, reembolsos, pagos mixtos y comisiones. `VEN-10`, `PEN-04`. |

### 3.2 Productos e inventario

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Generar y leer QR con cámara; admitir piezas únicas y existencias por cantidad sin individualizar unidades equivalentes. `PRO-01`, `PRO-02`. |
| CONFIRMADO | Tomar fotos desde la tablet y conservar historial de ingreso, costo, precios y venta. `PRO-03`, `PRO-04`. |
| CONFIRMADO | Registrar varias unidades iguales en una entrada rápida; una venta descuenta existencias. Mermas/salidas no comerciales llevan motivo y no son ventas. `INV-01` a `INV-03`. |
| PROPUESTO | Ficha con nombre, categoría, foto, costo, precio, existencia, ingreso, proveedor y notas; datos de plantas cuando correspondan. Campos obligatorios todavía sin definir. `PRO-05`. |
| PROPUESTO | QR con identidad estable, no con el precio incrustado; impresión de etiquetas y separación de datos comerciales e internos. `PRO-06`, `PRO-07`. |
| PROPUESTO | Explicar existencias mediante movimientos de entrada, venta, devolución, merma y ajuste. `INV-06`. |
| PENDIENTE | Identidad por pieza/cantidad, etiquetas, impresión, permisos, inventario inicial, ajustes, costeo y stock insuficiente. No se aprobó stock negativo. `PRO-08`, `INV-08`, `PEN-05`, `PEN-08`. |

### 3.3 Reservas internas y apartados

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Deben existir reservas internas, con marcas como «no vender», «apartado» o «en exhibición». Su efecto sobre la disponibilidad no está definido. `INV-04`. |
| CONFIRMADO | Debe poder registrarse un apartado cuando el cliente deja dinero y vuelve después. No es una función posterior al MVP. `INV-05`. |
| PENDIENTE | Estados y transiciones, anticipo mínimo, saldo, vencimiento, contacto, cancelación, devolución del anticipo y liberación de inventario. No asumir que una reserva interna tiene pago. `INV-07`, `PEN-03`. |

### 3.4 Gastos, capital y reintegros

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Registrar gastos del negocio, incluyendo alimentos, transporte/gasolina, renta, estacionamiento e insumos; identificar pagadores y porción empresarial/personal, incluso en gastos compartidos. `FIN-01`, `FIN-02`. |
| CONFIRMADO | Conservar pendientes de reintegro por gastos empresariales pagados por socios y el historial individual de inversiones/aportaciones. `FIN-03`, `FIN-04`. |
| PROPUESTO | Separar capital, trabajo y utilidades; distinguir aportación, gasto personal por cuenta del negocio, reintegro y retiro. Un retiro no es automáticamente gasto operativo. `PR-05`, `FIN-05`. |
| PROPUESTO | Utilidad operativa de referencia = ventas − costo de productos vendidos − gastos empresariales; no equivale a caja disponible ni a utilidad repartible. Reintegrar un gasto no vuelve a crearlo. `FIN-06`, `FIN-07`. |
| PENDIENTE | Recuperación del capital, participación, reparto, reinversión, costeo, reparto de gastos comunes, valoración de mermas, moneda, redondeos y reconocimiento de ventas/anticipos. No existe reparto 50/50 aprobado. `FIN-08`, `FIN-09`, `PEN-01`. |

### 3.5 Personas y trabajo

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Cada socio tiene cuenta personal; la tablet compartida no exige cerrar/iniciar sesión en cada venta. Se registran días u horas por persona y apoyo ocasional de los hermanos. `PER-01` a `PER-03`. |
| PROPUESTO | Diferenciar socio y colaborador; trabajar no concede participación. Asociar jornadas a persona, fecha, evento y tiempo; admitir apoyo sin pago o compensación acordada. `PER-04`, `PER-05`. |
| PROPUESTO | Separar pago por trabajo de reparto de utilidad y tratar compensación de colaboradores como costo operativo. Distinguir sesión autorizada de persona que atiende; selector rápido o PIN son alternativas, no decisiones. `PER-06`, `PER-07`. |
| PENDIENTE | Compensaciones, validación de jornadas, mecanismo de identificación y permisos. Administrador, vendedor y colaborador no constituyen una matriz aprobada. `PER-08`, `PEN-02`, `PEN-07`. |

### 3.6 Eventos, caja y reportes

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Registrar notas del día y cerrar el evento con ventas, gastos, utilidad, horas y productos vendidos. La fórmula de utilidad debe acordarse antes de presentarla como definitiva. `EVT-01`, `EVT-02`, `FIN-09`. |
| PROPUESTO | Relacionar ventas, gastos y jornadas con el evento; apertura/cierre de caja con fondo, movimientos, esperado, conteo y diferencias; separar medios de pago. `EVT-03`, `EVT-04`. |
| PROPUESTO | Reportes básicos de ventas, gastos, inventario, mermas, productos, rentabilidad, capital y pendientes con socios. `EVT-05`. |
| PENDIENTE | Responsables, caja compartida o varias cajas, diferencias, reaperturas y cierre con operaciones aún no sincronizadas. `EVT-06`, `PEN-06`. |

### 3.7 Dispositivos, continuidad y protección

| Estado | Regla y trazabilidad |
| --- | --- |
| CONFIRMADO | Una venta no se detiene por perder internet en un equipo preparado; guardar operaciones localmente y enviarlas cuando vuelva la conexión. `PR-01`, `SYN-01`. |
| CONFIRMADO | Identificar personas/dispositivos; solicitar nombre del equipo al registrarlo mediante inicio de sesión y admitir tablet/teléfonos como terminales. Pedirlo solo en el primer acceso es propuesta. `PR-04`, `DIS-01`, `DIS-02`. |
| PROPUESTO | Identidad estable, autorización, consulta y revocación de dispositivos; catálogo descargado y almacenamiento local para ventas, inventario, gastos y jornadas. `DIS-03`, `SYN-02`. |
| PROPUESTO | Cola automática con identidad por operación y trazabilidad; servidor valida, evita duplicados y confirma recepción; mostrar conexión y pendientes discretamente. `SYN-03` a `SYN-05`. |
| PROPUESTO | Auditar movimientos comerciales, financieros y sincronización; guardar actor, equipo, fecha, cambio y motivo aplicable; correcciones vinculadas al original, sin borrado económico silencioso. `PR-06`, `AUD-01` a `AUD-03`. |
| PROPUESTO | Separar datos comerciales de costos/finanzas y proteger acciones sensibles mediante permisos y eventual reautenticación. `AUD-04`. |
| PENDIENTE | Conflictos de precio/producto, sobreventa, rechazos, preparación inicial, datos por equipo, sesiones/revocación offline, pérdida del equipo, respaldo, retención y protección local. `SYN-06`, `SYN-07`, `AUD-05`, `PEN-07`. |

Offline no permite conocer en tiempo real las ventas de otro equipo desconectado. No se aprobó «gana el último cambio», ni descartar operaciones, ni aceptar automáticamente una sobreventa.

## 4. Reglas de oro

Las reglas **confirmadas** provienen del negocio o de esta solicitud. Las demás son **propuestas de trabajo**, no aprobaciones nuevas de políticas.

| ID | Estado | Regla práctica |
| --- | --- | --- |
| ORO-01 | CONFIRMADO | Dividir y vencer: desarrollar el proyecto poco a poco, como solicitó el usuario. |
| ORO-02 | CONFIRMADO | Offline y varios dispositivos son base del producto, no extras. `PR-01`, `DIS-02`, `SYN-01`. |
| ORO-03 | CONFIRMADO | La venta debe alimentar inventario e información financiera sin recaptura; no exigir ticket ni cliente en venta normal. `PR-02`, `PR-03`. |
| ORO-04 | PROPUESTO | Dividir por resultados utilizables de punta a punta, no hacer primero todo el backend y después toda la interfaz. |
| ORO-05 | PROPUESTO | Trabajar una entrega acotada a la vez; terminar su demostración y registrar evidencia antes de agregar otra. |
| ORO-06 | PROPUESTO | Traducir cada regla de la entrega a ejemplos comprobables, incluyendo errores y reconexión; comprobarlos con pruebas y una demostración operativa. |
| ORO-07 | PROPUESTO | Conservar hechos y correcciones: no borrar silenciosamente dinero o inventario ni reescribir precios históricos al cambiar el catálogo. `PR-06`, `PRO-04`, `AUD-03`. |
| ORO-08 | PROPUESTO | Reintentar una operación no debe duplicar venta, cobro registrado, gasto ni movimiento de stock. `SYN-04`. |
| ORO-09 | PROPUESTO | Registrar venta y sus efectos de forma consistente; un fallo no debe dejar venta sin su movimiento de inventario o viceversa. Es un criterio técnico a diseñar, no una arquitectura impuesta. |
| ORO-10 | PROPUESTO | Mantener separados capital, remuneración, gastos, caja y utilidad; un reintegro no duplica el gasto original. `PR-05`, `FIN-05` a `FIN-07`, `PER-06`. |
| ORO-11 | PROPUESTO | No fabricar decisiones para desbloquear código: documentar la pregunta, pedir aprobación y pausar solo la parte dependiente. |
| ORO-12 | PROPUESTO | Mantener el monolito modular confirmado y evitar complejidad sin una necesidad comprobada; no confundir módulos con despliegues. `TEC-03`. |
| ORO-13 | PROPUESTO | Actualizar documentación y contexto en Engram con decisiones, evidencia y siguiente paso; distinguir siempre decidido, propuesto y pendiente. |

El objetivo de una venta sencilla en dos o tres acciones sigue siendo **PROPUESTO**, no un límite para cualquier operación. `PR-07`.

## 5. Base técnica: decisiones y opciones

| Estado | Contenido |
| --- | --- |
| CONFIRMADO | Frontend y backend separados; Vue.js y NestJS; backend monolítico modular; arquitectura offline-first. `TEC-01` a `TEC-04`. |
| PROPUESTO | Vue 3, Pinia, Vue Router, PWA e IndexedDB; REST y PostgreSQL; JWT con refresh token, registro de dispositivos y cola local. `TEC-05` a `TEC-07`. |
| PROPUESTO | Módulos por autenticación, usuarios, dispositivos, productos, inventario, ventas, gastos, miembros, jornadas/eventos, sincronización y auditoría. Nombres y estructura abiertos. `TEC-08`. |
| PROPUESTO | ESM con Vitest y no agregar `@nestjs/observe` al arranque. No hay evidencia en la fuente de selección efectiva ni pruebas ejecutadas. `TEC-09`, `TEC-10`. |
| PENDIENTE | Confirmar opciones complementarias contra el repositorio antes de adoptarlas; no se eligieron ORM, alojamiento, proveedor de pagos ni esquema definitivo. `PEN-08`. |

No se exige event sourcing completo, bibliotecas adicionales ni decoradores propios. Esta guía no afirma qué dependencias están instaladas actualmente.

## 6. Divide y vencerás: entregas verticales propuestas

**Toda esta secuencia es PROPUESTA.** Cada entrega integra la interfaz, las reglas, la persistencia y la sincronización que necesite. Las dependencias expresan resultados previos, no un calendario. Las primeras entregas son incrementos del MVP, no el MVP completo.

### E0. Acordar una primera venta verificable

- **Resultado:** alcance breve y ejemplos de una venta normal, sin construir todavía toda la solución.
- **Dependencias:** ninguna; revisar fuente y estado real del repositorio al autorizar implementación.
- **Decisiones necesarias:** identidad pieza/cantidad, campos mínimos, moneda/redondeo, preparación de equipos, identificación de persona y permisos mínimos de esa venta. Resolver las partes necesarias de `PEN-05`, `PEN-07`, `PEN-08`.
- **Aceptación:** un ejemplo de pieza única y otro de producto repetido tienen datos, total esperado y actor/dispositivo definidos; las decisiones aprobadas quedan registradas y las demás siguen pendientes.

### E1. Primera venta sin conexión en tablet y teléfono

- **Resultado:** preparar ambos equipos, consultar catálogo mínimo por nombre, registrar una venta y sus efectos locales, reconectar y consultar el resultado central. `PR-01` a `PR-04`, `PRO-02`, `INV-01`, `INV-02`, `PER-01`, `DIS-01`, `DIS-02`, `SYN-01`.
- **Dependencias:** E0; aprobar criterios propuestos de identificación de operaciones, consistencia e idempotencia antes de adoptarlos.
- **Aceptación:** con ambos equipos preparados y sin red, cada uno vende existencias diferentes; al reconectar aparecen ambas operaciones con persona y dispositivo, sin recaptura.
- **Aceptación propuesta adicional:** cerrar/reabrir la aplicación conserva pendientes; reenviar la misma operación no duplica efectos. Se demuestra que vender con una segunda persona no exige reiniciar sesión.
- **Límite:** usar existencias diferentes en esta demostración no resuelve concurrencia ni autoriza uso real sin la política de E2.

### E2. Multidispositivo con errores y conflictos visibles

- **Resultado:** comprobar reintentos, recepción, rechazos y recuperación; aplicar únicamente la política de conflictos aprobada. `INV-08`, `SYN-03` a `SYN-07`, `AUD-05`.
- **Dependencias:** E1; resolver stock insuficiente, venta simultánea de una pieza, cambios concurrentes, datos offline, revocación y recuperación relevantes a la prueba.
- **Aceptación:** dos equipos desconectados intentan vender la misma pieza; al reconectar se aplica la resolución acordada, conservando la evidencia y sin inventar un ganador.
- **Aceptación:** una caída durante el envío y una operación rechazada producen estados comprobables; se ejecuta el procedimiento acordado de recuperación, incluyendo sus límites si el equipo se pierde sin sincronizar.
- **Puerta:** no declarar lista para operación real la venta multidispositivo mientras estos resultados y políticas sigan pendientes.

### E3. Catálogo y venta cotidiana completos

- **Resultado:** fotos desde tablet, historial, QR generado/leído, búsqueda alternativa, entradas por cantidad, carrito de varios productos, cambio en efectivo y precio ajustable. `PRO-01` a `PRO-04`, `VEN-01` a `VEN-04`, `VEN-07`.
- **Dependencias:** E1–E2; aprobar identidad de QR, alcance offline del catálogo y fotos, medios de pago, permisos y registro de ajustes.
- **Aceptación:** dar de alta una pieza y varias unidades equivalentes, tomar foto, generar QR y consultar precio; si falla el QR, encontrar por nombre y vender varios artículos con un cobro.
- **Aceptación:** ajustar un precio conserva la diferencia respecto al de referencia; el cálculo de cambio coincide con el ejemplo acordado y la venta se sincroniza sin duplicar inventario.

### E4. Cancelaciones, mermas y reservas internas

- **Resultado:** cancelar ventas con trazabilidad, registrar mermas con motivo y aplicar disponibilidad por reserva interna. `VEN-08`, `INV-02` a `INV-04`.
- **Dependencias:** E3; resolver permisos, motivos, devoluciones parciales/dañadas, reembolsos, estados de reserva y comportamiento offline.
- **Aceptación:** cancelar una venta elegible genera el movimiento inverso acordado; una devolución dañada sigue su política y no se convierte por defecto en existencia vendible.
- **Aceptación:** registrar una merma no genera venta; marcar «no vender» o «en exhibición» produce el efecto aprobado. Reintentar la sincronización no aplica dos veces la cancelación.

### E5. Apartados con dinero y ciclo completo

- **Resultado:** registrar anticipo, saldo y transición hasta entrega, cancelación o vencimiento según política. `INV-05`, `INV-07`, `PEN-03`.
- **Dependencias:** E3–E4; aprobar estados, disponibilidad, contacto, mínimo, plazos, devolución/liberación y reconocimiento financiero del anticipo.
- **Aceptación:** un cliente deja anticipo y después liquida/recoge; stock, saldo e historial coinciden con las reglas acordadas, también tras reconexión.
- **Aceptación:** cancelar o vencer un apartado aplica exactamente la devolución y liberación aprobadas; no se inventa penalización ni ingreso definitivo.

### E6. Gastos, aportaciones y reintegros

- **Resultado:** registrar gastos por pagador y porción empresarial, pendientes/reintegros y aportaciones individuales. `FIN-01` a `FIN-04`.
- **Dependencias:** E1–E2 y reglas monetarias de E0; coordinar con E4–E5 para consolidar efectos de devoluciones y anticipos.
- **Decisiones necesarias:** distribución de gastos compartidos, clasificación y reconocimiento; aprobar o ajustar separación financiera y no duplicación propuestas. El reparto entre socios sigue bloqueado por `PEN-01`.
- **Aceptación:** un socio paga un gasto parcialmente personal: solo la parte empresarial genera el pendiente aprobado; al reintegrarlo cambia el saldo sin duplicar el gasto.
- **Aceptación:** una aportación conserva socio e historial y no calcula automáticamente participación ni utilidad repartible; reintentar el envío no duplica importes.

### E7. Jornadas, notas y cierre integrado del evento

- **Resultado:** registrar trabajo de socios/familiares, notas y cierre con ventas, gastos, utilidad, horas y productos vendidos. `PER-02`, `PER-03`, `EVT-01`, `EVT-02`.
- **Dependencias:** E3–E6 para el cierre completo; el registro básico de jornadas/notas puede adelantarse tras E1–E2 si se aprueba una entrega separada.
- **Decisiones necesarias:** validación/compensación de jornadas, costeo y utilidad, asociación a evento, responsables, cajas, diferencias, reaperturas y operaciones pendientes. `PEN-01`, `PEN-02`, `PEN-06`.
- **Aceptación:** registrar distintas horas por persona y una nota; el cierre concilia productos vendidos, cancelaciones, gastos, reintegros y apartados según su tratamiento aprobado, sin confundir utilidad con caja.
- **Aceptación:** intentar cerrar con movimientos sin sincronizar sigue la regla acordada y no presenta un resultado incompleto como definitivo.
- **Cierre del MVP:** demostrar el recorrido integral E1–E7, con permisos, historial y continuidad aprobados. Una entrega pendiente no se elimina del MVP por llamarlo «mínimo».

## 7. Decisiones que no debemos inventar

| Puerta | Decisión pendiente | Se necesita antes de |
| --- | --- | --- |
| `PEN-01` | Capital, devoluciones, remuneración, retiros, reinversión y reparto. | Automatizar compensaciones/repartos y cerrar resultados financieros definitivos. |
| `PEN-02` | Compensación, apoyo sin pago, permisos y validación de jornadas. | Habilitar acciones de colaboradores y liquidar su trabajo. |
| `PEN-03` | Reservas, disponibilidad, anticipo, vencimiento, cancelación y devolución. | Activar E4–E5 con esos comportamientos. |
| `PEN-04` | Descuentos, autorizaciones, devoluciones, medios de pago y reembolsos. | Habilitar los casos correspondientes de E3–E4. |
| `PEN-05` | Pieza/cantidad, ajustes, costeo y conflictos offline. | E0–E2 para identidad/conflictos; reportes para costeo. |
| `PEN-06` | Responsables, terminales/cajas, diferencias y cierre con pendientes. | Cierre integrado de E7. |
| `PEN-07` | Acceso e identificación offline, revocación, respaldo y recuperación. | Primera operación autorizada y validación de continuidad E1–E2. |
| `PEN-08` | Campos, moneda/redondeo, etiquetas y stack complementario. | Diseñar el primer contrato de datos; impresión cuando se apruebe. |

## 8. Criterio propuesto para terminar cada entrega

- [ ] Alcance autorizado y reglas de origen identificadas; propuestas adoptadas explícitamente.
- [ ] Decisiones que afecten al comportamiento resueltas; pendientes restantes visibles.
- [ ] Camino normal, errores y casos offline/multidispositivo aplicables demostrados.
- [ ] Inventario, dinero e historial explicables, sin duplicados por reintentos.
- [ ] Comprobaciones ejecutadas y resultados registrados; fallos u omisiones declarados.
- [ ] Documentación y contexto en Engram actualizados con evidencia y siguiente paso.

**Siguiente acción:** revisar y aprobar únicamente el alcance y las decisiones mínimas de E0. Después, autorizar la primera entrega de implementación. Este documento deja preparada la ruta; no significa que E0–E7 estén iniciadas ni aprobadas.

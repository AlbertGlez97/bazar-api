# Reglas de negocio consolidadas (hasta BE-10)

## Productos
- Un producto es "unica" o "cantidad". Única inicia con existencia 1; al venderse pasa a 0 (nunca se marca "vendida", el estado vendido se infiere de existencia=0). El frontend muestra en gris y deshabilita productos con existencia 0.
- Campos obligatorios: nombre, tipo, precio de venta, existencia inicial. Opcionales: imagen, categoría, costo de compra, proveedor, notas.
- Solo Member con role="socio" puede crear/editar productos. Los "colaborador" solo consultan.
- Toda edición de producto queda registrada en un historial de auditoría (quién, cuándo, valores anterior/nuevo), especialmente para cambios de precio.
- Las imágenes se suben como archivo real (no URL de texto) y se guardan en disco local del servidor por ahora; se diseñó detrás de una interfaz de storage para poder migrar a object storage (ej. MinIO) sin tocar el módulo de productos.
- El listado de productos está paginado desde BE-04.

## Dinero
- Moneda única: MXN. Todos los montos se almacenan como enteros en centavos (sufijo *Minor en los nombres de campo).
- Las operaciones aritméticas sobre dinero usan la librería dinero.js, nunca Number ni Decimal directamente.
- Los DTO que reciben montos validan que sean enteros (@IsInt()) para rechazar decimales mal formados en la entrada.

## Identificadores
- Todo identificador creado por los servicios del backend usa UUIDv7 mediante la librería oficial `uuid`. El orden temporal incorporado en UUIDv7 reduce la dispersión de inserciones en índices de tablas que crecen continuamente, como `SaleItem` e `Incidencia`, sin renunciar a identificadores globalmente únicos.
- Los identificadores fijos y legibles del seed son una excepción intencional para datos de arranque reconocibles y reejecutables; no representan el mecanismo de generación usado en producción y no deben reemplazarse por valores aleatorios.
- `Sale.id` pertenece al cliente porque la tablet debe generarlo aun sin conexión y reutilizarlo como clave de idempotencia. El backend no lo reemplaza; se recomienda que el frontend genere UUIDv7 para conservar la misma localidad temporal en el índice.
- Los `@default(uuid())` existentes en Prisma se conservan como respaldo para fixtures y operaciones administrativas directas. Los flujos HTTP de producción asignan explícitamente UUIDv7 antes de cada creación para mantener la política visible en los servicios y evitar una función específica de PostgreSQL.

## Preparación offline
- Antes de operar sin conexión, cada dispositivo debe haber iniciado sesión al menos una vez con internet, tener el catálogo descargado (nombre, precio, existencia) y su propio nombre de dispositivo registrado.
- Las ventas hechas offline se guardan localmente y se sincronizan al reconectar.

## Identificación de vendedor y dispositivos
- La tablet/teléfono es compartida entre socios. Se elige rápidamente qué socio/colaborador está atendiendo mediante un selector de persona, sin PIN.
- Los dispositivos deben estar autorizados previamente (vía seed) para poder operar.
- El ContextGuard exige que cuenta, miembro y dispositivo pertenezcan al mismo contexto autorizado.

## Socios y colaboradores
- Member tiene role: "socio" | "colaborador". Los socios (Alberto y Adid) tienen privilegios administrativos completos (incluye alta de productos). Los colaboradores (futuro: familiares que ayuden a vender) solo pueden registrar ventas y consultar catálogo.
- Cualquier socio o colaborador autenticado puede registrar una venta.
- Descuentos y cancelaciones están bloqueados hasta que se defina una política aparte (no implementados en E0).

## Ventas (BE-05)
- Venta presencial al contado en el bazar, no e-commerce.
- El servidor SIEMPRE calcula el total con el precio actual de Product en base de datos; el unitPriceMinor que manda el cliente en el request se ignora para el cálculo.
- Si cashReceivedMinor es menor al total, se rechaza la venta completa (400). No hay fiado en este flujo de venta al contado; ver sección "Fiado y apartados (Deuda)" para el concepto de crédito/apartado, implementado por separado en BE-09.
- Si algún item no tiene stock suficiente, se rechaza LA VENTA COMPLETA (atómica, todo o nada), no una venta parcial.
- Toda la venta ocurre dentro de una única transacción: cálculo, validación de stock, descuento de existencia y persistencia. Un fallo revierte todo.
- El memberId y deviceId del body deben coincidir con el contexto autenticado (ContextGuard); si no coinciden, se rechaza con 403.
- Descuento de existencia: única pasa de 1 a 0; cantidad resta las unidades vendidas.

## Explícitamente fuera de alcance de E0 (pendiente para entregas futuras)
- Resolución automática de conflictos de sincronización offline (reembolso, reasignación de stock a la venta perdedora): permanece una decisión humana fuera del sistema (ver BE-06).
- Migración de almacenamiento de imágenes de disco local a object storage (MinIO en home-lab). No implementado.
- Pago efectivo de comisiones (marcar una comisión como "pagada", integración con algún medio de pago): BE-08 solo calcula el monto; el pago en sí sigue siendo manual y fuera del sistema.

## Metodología de desarrollo
- TDD desactivado en BE-02 a BE-04 (infraestructura, auth, productos). Activo desde BE-05 (venta, cálculos, idempotencia).

## Documentación de API
- La documentación OpenAPI/Swagger vive en /docs, protegida con HTTP Basic Auth (credenciales independientes del sistema de auth de socios/colaboradores, vía DOCS_USER/DOCS_PASSWORD).
- Solo se registra si ENABLE_API_DOCS=true está presente en el entorno; si no, la ruta no existe (404, no 401), para no revelar su existencia.
- No usar el mismo mecanismo de credenciales que la API de negocio; son capas de acceso distintas.

## Idempotencia y conflictos offline (BE-06, extendido en BE-07)
- Reenviar una venta con el mismo id y el mismo payload devuelve el resultado ya persistido con 200 OK (no 201, que queda reservado para la creación real de una venta nueva), sin duplicar ni volver a descontar stock. Si el payload difiere, se rechaza con 409.
- Dos requests con el mismo id nuevo en carrera real (ambos pasan la verificación previa como "no existe") pueden chocar en la escritura misma: el segundo intento captura específicamente el error P2002 (violación de unicidad) del id de Sale, relee la venta ya persistida por el primero y aplica la misma regla de idempotencia (200 si el payload coincide, 409 si no) — nunca revienta como error 500 genérico.
- Ante conflicto de stock entre ventas offline sincronizadas sobre el mismo producto, gana la que el servidor procesa primero (orden real de procesamiento, no hora del dispositivo).
- Las ventas que pierden el conflicto no se pierden ni se descartan: quedan guardadas con status="rechazada_por_conflicto" y motivo, sin afectar inventario, disponibles para revisión y resolución manual con el cliente. Desde BE-07 este conflicto también genera un registro en la tabla Incidencia (ver sección siguiente); Sale.status se conserva además de Incidencia porque sirve como filtro barato/rápido ("¿esta venta afectó inventario?"), mientras que Incidencia sostiene el flujo de seguimiento y resolución.
- No hay resolución automática de conflictos (reembolso, reasignación de stock); es una decisión humana fuera del sistema.

## Incidencias
- Las incidencias (conflicto de stock, fecha fuera de rango) se registran en una tabla propia (Incidencia), no solo como un estado de Sale, para permitir consulta, filtrado, paginación y seguimiento de resolución independiente del ciclo de vida de la venta.
- Toda incidencia queda en estado "pendiente" hasta que un socio la marca como "resuelta" con notas de qué se acordó con el cliente. No hay resolución automática.
- Solo socios pueden ver y resolver incidencias; colaboradores no tienen acceso.
- occurredAt fuera de rango (futuro, o más de 2 días en el pasado respecto a receivedAt) genera una incidencia tipo "incidencia_fecha" sin bloquear la venta si es válida en lo demás.
- JWT de dispositivos: expiresIn extendido a 12h para cubrir una jornada de bazar sin requerir refresh token, dado que los dispositivos ya están pre-autorizados por seed.

## Comisiones (BE-08)
- La comisión de un colaborador es un porcentaje del total que vendió en el periodo (no un monto fijo por venta), para que el pago escale con lo que realmente ayudó a vender, no de forma pareja entre un turno flojo y uno fuerte.
- Existe un porcentaje global por defecto (AppSettings, una fila por contexto); cada colaborador puede tener uno individual (Member.commissionRateBps) que lo sobrescribe cuando no es null. Solo socios los configuran (PATCH /settings/commission-rate y PATCH /members/:id/commission-rate).
- Ambos porcentajes se almacenan como enteros en puntos base (1000 = 10.00%), siguiendo la misma convención de enteros que el dinero, para evitar imprecisión de punto flotante.
- El corte de periodo es semanal, domingo a sábado, usando receivedAt (fecha del servidor) como referencia, no occurredAt. La zona horaria asumida es America/Mexico_City, fija en UTC-6 todo el año (la reforma de 2022 eliminó el horario de verano en la mayor parte del país), documentada explícitamente en src/common/business-time.ts ya que el proyecto no tenía una convención de zona horaria previa a esta entrega.
- Si no se pasan fechas explícitas a GET /commissions, se resuelve automáticamente la semana domingo-sábado actual.
- El cálculo solo considera ventas con status="completada"; ventas con una Incidencia pendiente de resolver igual se incluyen en el cálculo (la incidencia se resuelve por separado; si su resolución cambia el resultado de una venta, el recálculo es manual, el sistema no oculta ventas del cálculo solo por tener una incidencia pendiente).
- La multiplicación por el porcentaje se hace con dinero.js (factor racional exacto vía scale, redondeo half-up al convertir de vuelta a centavos), nunca con Number/Decimal.
- Esta entrega solo calcula el monto de comisión; no implementa pago ni lo marca como pagado (ver sección "fuera de alcance").

## Reportes (BE-08)
- Dos reportes disponibles: GET /reports/sales-by-period (total vendido y número de ventas en un rango), y GET /reports/sales-by-member (desglose del total vendido por cada Member, socio o colaborador), ambos filtrables por rango de fechas (from/to, aceptando fecha simple o instante ISO-8601 completo) y restringidos a socios.
- Solo cuentan ventas con status="completada".
- Un valor from/to de solo fecha (sin hora) se interpreta como el día completo en la zona horaria de negocio (inicio de ese día para from, fin de ese día para to), para que un socio pueda pedir "las ventas del 5 de mayo" sin tener que calcular instantes UTC a mano.

## Fiado y apartados (Deuda)
- Un solo concepto "Deuda" con dos tipos: "fiado" (producto ya entregado) y "apartado" (producto reservado). Ambos descuentan inventario de inmediato al crearse, para evitar que el producto se venda dos veces mientras el cliente abona.
- Solo socios pueden autorizar una Deuda (crear un fiado/apartado). Cualquier Member (socio o colaborador) puede registrar abonos.
- El total se calcula con el precio actual del producto, igual que en ventas — el servidor no confía en el precio que mande el cliente.
- Un abono no puede exceder el saldo pendiente. El estado "saldada" se deriva automáticamente cuando los abonos cubren el total; no se marca manualmente.
- El deudor se registra con nombre, teléfono opcional y notas opcionales — sin validación de identidad formal.
- Deuda es deliberadamente de un solo producto/cantidad (no una lista de items como Sale/SaleItem): la especificación de BE-09 define campos escalares (productId, cantidad), y en la práctica un fiado/apartado informal se negocia por pieza con el cliente, no como un carrito de compras. Un cliente que quiere crédito sobre varios productos distintos se representa hoy como varias filas de Deuda; graduar a un modelo multi-item (espejo de SaleItem) queda pendiente si esta suposición resulta incorrecta en la práctica.
- POST /deudas acepta un deudorId existente o un objeto deudor inline (nombre/telefono/notas) para crear uno nuevo en la misma transacción; exactamente uno de los dos debe enviarse.
- No hay reconciliación de conflictos de sincronización offline para Deuda (a diferencia de Sale/BE-06): una Deuda siempre se crea en persona, en línea, por un socio, así que stock insuficiente es siempre un rechazo simple (400), nunca un registro de conflicto persistido.

## Eliminación de productos y colaboradores (soft delete)
- Ni productos ni colaboradores se borran físicamente de la base de datos. Se desactivan mediante un campo active, preservando todo el historial relacionado (ventas, auditoría, comisiones, incidencias, deudas).
- Un producto desactivado no aparece en el catálogo de venta ni puede venderse, pero su historial permanece intacto y consultable.
- Un colaborador desactivado no puede iniciar sesión ni ser seleccionado como vendedor, pero su historial de ventas y comisiones pasadas permanece intacto.
- Los socios (Alberto y Adid) no pueden desactivarse mediante este mecanismo.
- Ambas entidades pueden reactivarse.
- Detalle de implementación: este sistema no tiene login por Member (solo por Account, compartido entre socio y colaboradores del mismo dispositivo); "un colaborador desactivado no puede iniciar sesión" se aplica en la práctica como "no puede ser seleccionado como el actor de la sesión" en ContextGuard, que es el único punto donde un Member se resuelve por request — un Member con active=false deja de resolver ahí, bloqueando cualquier venta, deuda o mutación de catálogo atribuida a esa persona.
- DELETE /products/:id y DELETE /members/:id son idempotentes: desactivar un registro ya inactivo devuelve 200 con el estado actual, no un error 409 — no hay una preocupación de proveniencia de datos como en resolver una incidencia dos veces, así que tratarlo como error solo complicaría la lógica de reintento del frontend sin ganar seguridad.
- GET /products y GET /members aceptan ?includeInactive=true para que un socio revise el catálogo/roster completo (incluyendo desactivados); por ahora se honra para cualquier cuenta autenticada, no solo socios, ya que estos endpoints de lectura no tienen selección de member/device con la que verificar rol sin un cambio de guard más amplio, y el riesgo de exponer nombres de productos/colaboradores desactivados es bajo.

---

Este documento se actualiza conforme se cierran nuevas decisiones de negocio en cada entrega. Última actualización: BE-10.

## Notas de verificación de la implementación
- Las ventas nuevas conservan una huella del request normalizado, incluidos los productos y cantidades intentados en una venta rechazada por conflicto. Cambiar esos datos al reenviar el mismo identificador devuelve 409; el precio enviado por el cliente no forma parte de la identidad porque no es autoritativo.
- Las ventas históricas rechazadas sin huella ni partidas no permiten reconstruir el request original. Sus reenvíos devuelven 409 de forma conservadora; no se inventa ni elimina historial.
- La detección de conflicto de stock actual cubre la carrera entre transacciones. Una solicitud secuencial que llega cuando ya no hay stock devuelve 400, sin crear una incidencia; no equivale a una reconciliación completa de todas las colas offline.
- La documentación JSON/YAML también requiere las credenciales independientes de documentación cuando está habilitada, no solo la interfaz `/docs`.

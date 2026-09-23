# Reglas de negocio consolidadas (hasta BE-05)

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
- Si cashReceivedMinor es menor al total, se rechaza la venta completa (400). No hay fiado en este flujo.
- Si algún item no tiene stock suficiente, se rechaza LA VENTA COMPLETA (atómica, todo o nada), no una venta parcial.
- Toda la venta ocurre dentro de una única transacción: cálculo, validación de stock, descuento de existencia y persistencia. Un fallo revierte todo.
- El memberId y deviceId del body deben coincidir con el contexto autenticado (ContextGuard); si no coinciden, se rechaza con 403.
- Descuento de existencia: única pasa de 1 a 0; cantidad resta las unidades vendidas.

## Explícitamente fuera de alcance de E0 (pendiente para entregas futuras)
- Resolución automática de conflictos de sincronización offline (reembolso, reasignación de stock a la venta perdedora): permanece una decisión humana fuera del sistema (ver BE-06).
- Comisiones para colaboradores: pago semanal (domingo) por defecto, con día de pago y porcentaje configurables desde el frontend. No implementado.
- Fiado / apartados de clientes con pagos a plazos: concepto separado (tipo Debt/Layaway) con registro de deudor y abonos. No implementado.
- Migración de almacenamiento de imágenes de disco local a object storage (MinIO en home-lab). No implementado.

## Metodología de desarrollo
- TDD desactivado en BE-02 a BE-04 (infraestructura, auth, productos). Activo desde BE-05 (venta, cálculos, idempotencia).

## Documentación de API
- La documentación OpenAPI/Swagger vive en /docs, protegida con HTTP Basic Auth (credenciales independientes del sistema de auth de socios/colaboradores, vía DOCS_USER/DOCS_PASSWORD).
- Solo se registra si ENABLE_API_DOCS=true está presente en el entorno; si no, la ruta no existe (404, no 401), para no revelar su existencia.
- No usar el mismo mecanismo de credenciales que la API de negocio; son capas de acceso distintas.

## Idempotencia y conflictos offline (BE-06)
- Reenviar una venta con el mismo id y el mismo payload devuelve el resultado ya persistido, sin duplicar ni volver a descontar stock. Si el payload difiere, se rechaza con 409.
- Ante conflicto de stock entre ventas offline sincronizadas sobre el mismo producto, gana la que el servidor procesa primero (orden real de procesamiento, no hora del dispositivo).
- Las ventas que pierden el conflicto no se pierden ni se descartan: quedan guardadas con status="rechazada_por_conflicto" y motivo, sin afectar inventario, disponibles para revisión y resolución manual con el cliente.
- No hay resolución automática de conflictos (reembolso, reasignación de stock); es una decisión humana fuera del sistema.

---

Este documento se actualiza conforme se cierran nuevas decisiones de negocio en cada entrega. Última actualización: BE-06.

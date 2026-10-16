# Reposición de existencia (restock)

Un socio puede sumar piezas a un producto **por cantidad** y dejar constancia. Antes de esto la existencia solo subía al crear el producto y solo bajaba con ventas y deudas.

Contrato HTTP: [`POST /api/v1/products/:id/restock`](api-contract-for-frontend.md#ep-products-restock).

## Decisiones

| # | Decisión |
|---|---|
| 1 | Solo productos `cantidad` y solo socios. Un producto `unica` no se repone (400): una pieza única que "vuelve" es una devolución o una corrección, no una compra. |
| 2 | Modelo `StockMovement` (append-only): `type` (enum, hoy solo `REPOSICION`), `quantity`, `stockBefore`, `stockAfter`, `unitCostMinor` (opcional), `note` (opcional), `memberId`, `createdAt`. |
| 3 | Multi-tenant: `contextId` en la tabla, filtro de la extensión de Prisma (`TENANT_SCOPED_MODELS`), RLS `FORCE` con política `tenant_isolation` (deny-by-default) y permisos del rol de runtime en `scripts/provision-app-role.mjs`. |
| 4 | Operación atómica: `stock = stock + n` en una transacción junto con el movimiento. Nunca leer-modificar-escribir. |
| 5 | Costo del producto: promedio ponderado (ver abajo). |
| 6 | La respuesta trae el producto actualizado y el movimiento. |

## Migración

`prisma/migrations/20261015200000_stock_movements`

Aditiva: crea el enum `StockMovementType` y la tabla `StockMovement` con sus restricciones, el índice `(contextId, productId, createdAt, id)`, las claves foráneas a `Product` y `Member` (`ON DELETE RESTRICT`) y la política RLS. No cambia ninguna tabla ni fila existente. Se aplica sola al desplegar (`docker-entrypoint.sh` corre `prisma migrate deploy` y luego el aprovisionamiento del rol).

Restricciones de la tabla: `quantity > 0`, `stockBefore >= 0`, `stockAfter = stockBefore + quantity`, `unitCostMinor >= 0` o nulo, `note` de hasta 1000 caracteres.

## Atomicidad y concurrencia

El `UPDATE ... SET stock = stock + n` lleva en su `WHERE` todas las reglas (negocio correcto, `tipo = cantidad`, `active`, sin desbordar el rango de Int). Además toma el bloqueo de la fila, que la transacción conserva hasta confirmar: una reposición concurrente espera en su propio incremento y luego ve el stock y el costo de la primera. Por eso el costo ponderado también es correcto bajo concurrencia, y una venta simultánea tampoco se pierde.

## Permisos del rol de runtime

El rol de runtime recibe `SELECT, INSERT, UPDATE, DELETE` sobre todas las tablas (`GRANT ... ON ALL TABLES` y privilegios por defecto), y el script de aprovisionamiento le **revoca `UPDATE` y `DELETE` sobre `StockMovement`** después de cada ejecución (`APPEND_ONLY_TABLES`). El historial de movimientos no se puede reescribir con las credenciales de la aplicación. Consecuencia: un producto con movimientos no se puede borrar (la clave foránea es `RESTRICT`), lo cual es coherente porque los productos solo se desactivan.

## Costo (promedio ponderado)

`src/products/restock-cost.ts` (`nextProductCost`). Centavos enteros; las entradas y la salida pasan por `toDinero`/`toMinorUnits`, así que un monto negativo, decimal o fuera de rango falla.

| Situación | `purchaseCostMinor` del producto |
|---|---|
| costo de la compra vacío | no se toca |
| existencia anterior = 0 | pasa a ser el costo de la compra |
| existencia anterior > 0 y costo actual conocido | `(existencia × costo actual + n × costo nuevo) / (existencia + n)` |
| existencia anterior > 0 y costo actual `null` | no se toca (desconocido no es cero) |

**Redondeo:** half-up a centavos enteros (`x.5` sube, no se redondea al par), la misma convención que las comisiones. Ejemplos: `(1×100 + 1×101)/2 = 100.5 → 101`; `(2×100 + 1×101)/3 = 100.33 → 100`; `(1×100 + 2×101)/3 = 100.67 → 101`.

**Nota sobre dinero.js:** la suma de productos `existencia × costo` puede pasar de 2^53 (y del rango de Int que dinero exige en cada monto), donde un `number` perdería centavos. Por eso la suma y la división se hacen con `BigInt`, y dinero.js valida las entradas y la salida. Un costo de 0 es un costo conocido y se promedia como cualquier otro.

Las ventas ya hechas conservan su `unitCostMinor` (instantánea), así que ningún caso altera el pasado.

Además se escribe una fila de auditoría del producto con `stock` y `purchaseCostMinor` antes y después, para que `GET /products/:id/audit` explique el cambio.

## Fuera de alcance (pendiente)

- **Corregir existencia:** fijar la existencia a un valor contado (errores de conteo), con nota obligatoria. El enum `StockMovementType` está pensado para agregar otro valor sin reformar la tabla.
- **Historial de movimientos:** no hay endpoint ni vista para listar los `StockMovement` de un producto. Hoy se ven en la auditoría del producto (`GET /products/:id/audit`).
- Las ventas y deudas, que bajan la existencia, no escriben `StockMovement` ni auditoría (como antes).

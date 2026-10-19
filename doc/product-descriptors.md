# Marca, presentación y descripción del producto

Tres datos opcionales para distinguir productos parecidos y para mostrar la ficha de un producto al escanear su QR. No hay campo de ubicación y no hay variantes: cada combinación que se quiera controlar (modelo, talla, color) es **un registro propio** con su existencia y su QR.

## Campos

| Columna | Máximo | Qué lleva |
|---|---|---|
| `brand` | 40 | Marca. |
| `presentation` | 40 | Talla, tamaño o capacidad: "XL", "24 oz". El color va dentro: "Azul · 28". |
| `description` | 200 | Descripción breve. |

Los tres son `NULL` en los productos que ya existían. Un cliente viejo que no los manda sigue funcionando.

## Migración

`prisma/migrations/20261019120000_product_brand_presentation_description`

Aditiva: tres `ADD COLUMN ... TEXT` sin valor por omisión ni relleno. No cambia ninguna fila ni columna existente. Se aplica sola al desplegar. El backend va primero; con la migración aplicada y el frontend viejo, las respuestas solo traen tres claves más.

## Reglas al guardar (crear y editar)

- Se limpian con el sanitizador común (`cleanText`): sin caracteres de control ni invisibles, un salto de línea cuenta como un espacio, los espacios repetidos se juntan y se recortan los extremos. Sin expresiones regulares con retroceso.
- El máximo se mide **después** de limpiar.
- Vacío o solo espacios se guarda como `null`. En `PATCH`: ausente = no se toca; `null` o vacío = se borra.
- No se acepta algo que no sea texto (400).
- La auditoría (`ProductAudit.before/after`) guarda los tres campos.

## Lectura

- `GET /products?search=` busca en **nombre, marca y presentación**, sin distinguir mayúsculas. No distingue mayúsculas, **sí** acentos (igual que la búsqueda de antes).
- `GET /products?brand=` filtra por marca: igualdad exacta sin distinguir mayúsculas, con el valor normalizado igual que al guardar. Vacío = sin filtro. Se combina con los demás filtros.
- `GET /products/suggestions` (**solo socios**): `{ brands: string[], presentations: string[] }`. Valores distintos de productos **activos** del negocio, ordenados, máximo 200 de cada uno; "Nike" y "NIKE" cuentan una vez. No devuelve nada más del producto.

## Costo y colaboradores

Antes de este cambio `GET /products`, `GET /products/:id` y `GET /products/:id/audit` devolvían `purchaseCostMinor` a **cualquier** cuenta, incluido un colaborador. Ahora solo lo reciben quienes `x-member-id` identifica como socio activo (la misma comprobación de `includeInactive`; una cuenta ligada a un colaborador no puede usar el encabezado de un socio). Para los demás **la clave no aparece** (no es `null`: `null` se leería como "sin costo"). En el historial se quita de `before` y `after`.

Un colaborador recibe marca, presentación y descripción.

No cambió: `supplier` y `notes` siguen visibles en esas lecturas, y las respuestas de venta guardan `unitCostMinor` por línea; ver "Pendiente" en el reporte de la entrega.

## Compatibilidad

- Ausentes = `null` en las respuestas.
- La cola de ventas (`POST /sales`) no cambia.
- Contrato HTTP: [`api-contract-for-frontend.md`](api-contract-for-frontend.md#ep-products-create).

Fuente: `src/products/dto/product.dto.ts`, `src/products/products.service.ts`, `src/products/products.controller.ts`, `test/products-descriptors.e2e-spec.ts`.

## Reportes

`GET /reports/sales-detail` (solo socios) agrega a cada fila `productBrand` y `productPresentation`: los valores **actuales** del producto (no una foto de la venta), `null` si no tiene. Sirven para distinguir tallas y colores del mismo modelo en la pantalla, el PDF y el Excel. Es aditivo: una fila sigue teniendo todo lo de antes.

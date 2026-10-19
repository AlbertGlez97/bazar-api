# Reglas de revisión — bazar-api (NestJS, Prisma, Postgres)

Revisa solo lo que cambió. Responde STATUS: PASSED si cumple todo; STATUS: FAILED y la lista de problemas si no.

## Debe cumplir
- Todo dato de un negocio se filtra por `contextId`; nunca devolver datos de otro negocio.
- Los colaboradores no reciben `purchaseCostMinor` ni costos; las rutas de gestión llevan `SocioGuard`.
- Entradas de texto libre: se limpian con `cleanText` y se limitan en el DTO.
- Sin expresiones regulares con cuantificadores anidados o ambiguos (retroceso super-lineal). Prefiere recorridos lineales.
- Sin `NOSONAR`, sin `eslint-disable`/`oxlint-disable` para silenciar reglas, sin bajar umbrales ni excluir código de Sonar.
- Migraciones de Prisma aditivas y con nombre descriptivo; nada que borre datos sin aviso.
- Código nuevo con pruebas (unitarias y, si toca la base, e2e). Cobertura de código nuevo ≥ 80 %.
- Texto para personas usuarias en español.
- Sin secretos, claves ni contraseñas en el código.
- Saltos de línea consistentes (LF en el repositorio); sin `\r` dobles.

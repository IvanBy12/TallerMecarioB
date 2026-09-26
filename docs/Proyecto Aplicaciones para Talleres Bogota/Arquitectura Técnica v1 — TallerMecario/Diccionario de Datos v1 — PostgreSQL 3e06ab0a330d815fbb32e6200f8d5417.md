# Diccionario de Datos v1 — PostgreSQL

<aside>
📚

**Objetivo:** contrato canónico de columnas, tipos, nulabilidad, defaults, claves, mutabilidad e integridad del ERD definitivo de TallerMecario. Este documento y sus páginas hijas serán la fuente para generar Drizzle/SQL después de levantar el Documentation Freeze.

</aside>

**Estado:** Baseline documental definitivo — Sprint 0  

**Motor:** PostgreSQL 18.x  

**Fuente de verdad:** ERD + este diccionario; si una descripción narrativa antigua contradice una definición canónica aquí, debe corregirse antes de implementar.

# 1. Convenciones

- PK de entidades: `uuid NOT NULL`; UUID/UUIDv7 generado por aplicación. No usar `serial`/IDs globales secuenciales como autoridad.
- Toda tabla tenant-owned lleva `tenant_id uuid NOT NULL` y `UNIQUE(tenant_id,id)` cuando necesita ser padre de FK compuesta.
- Fechas: `timestamptz` UTC.
- Dinero: `bigint` en unidad mínima; `currency char(3)` ISO-4217.
- Cantidades: `numeric(14,4)` y `> 0` cuando representan una cantidad real.
- Tasas porcentuales: `numeric(7,4)` expresada en puntos porcentuales (`19.0000 = 19%`) con `0 <= rate <= 100`.
- Texto libre largo: `text`; códigos/estados: `varchar` con CHECK explícito cuando el conjunto es cerrado.
- `created_at` no se modifica. `updated_at` solo existe en entidades mutables.
- Campos `tenant_id`, actor/ownership, estados y valores derivados son server-owned salvo flujo offline explícitamente autorizado.
- FKs tenant-owned usan `(tenant_id,fk_id)`; cada FK compuesta tiene índice equivalente en la hija.
- Borrado físico deny-by-default. Históricos/evidencias son append-only para runtime.
- `ON DELETE CASCADE` no se usa desde entidades de negocio hacia históricos/evidencias. Solo puede usarse en tablas puramente asociativas/configurativas sin valor histórico y si el diccionario lo autoriza.

# 2. Semántica de mutabilidad

- **Mutable:** UPDATE por comandos de dominio autorizados.
- **Frozen-on-send/confirm/complete:** mutable hasta evento indicado; luego campos protegidos no cambian.
- **Append-only:** runtime puede INSERT/SELECT, no UPDATE/DELETE/TRUNCATE.
- **Derived:** no es fuente de verdad; debe reconstruirse/reconciliarse desde ledger/estado canónico.

- **Frozen-on-close:** fila de historial con vigencia. Mientras está abierta, solo su timestamp de cierre puede pasar de NULL a un valor válido y los demás campos no cambian. Una vez cerrada es inmutable, incluidas las reescrituras con el mismo valor y las reaperturas. Los cambios se representan cerrando e insertando. Aplica a `vehicle_owners` (Diccionario 01 §12; S2-02).

# 3. Integridad que se cierra en este diccionario

- `service_order_items` prueba por FK que un `quote_item_id` pertenece a la **misma orden**.
- En ítems provenientes de cotización, `service_order_items.catalog_item_id` copia la identidad de `quote_items.catalog_item_id` cuando exista para soportar inventario; snapshots de nombre/precio/impuesto/garantía siguen siendo la autoridad histórica y evitan que cambios futuros del catálogo alteren la orden.
- `quote_authorization_items` lleva `quote_version_id` y prueba por FK que autorización e ítem pertenecen a la misma versión.
- `service_order_items.quantity_billed` separa lo ejecutado de lo finalmente facturable; `line_total` usa cantidad facturada.
- Garantía de orden conserva `warranty_origin` y motivos de ajuste/cancelación.
- TTL baseline: invitación 7 días; link de autorización de cotización 72 h; OTP 5 min; seguimiento público de orden 30 días (todos pueden revocarse antes y la validación siempre compara `expires_at`).
- Feature flag `value_json` tiene semántica **replace por scope**, no deep-merge entre tenant/plan/global.

# 4. Páginas del diccionario

Se divide por dominios para mantener el documento auditable. Cada página usa el formato `columna | tipo | null/default | constraints/FK | mutabilidad/notas`. Inventario validado: **69 tablas canónicas, 0 faltantes** frente al ERD, incluyendo `inventory_balances` e `inventory_movements`.

# 5. Reglas de implementación posterior

- El diccionario no autoriza todavía la creación de migraciones hasta que el ERD padre marque formalmente el Documentation Freeze como cerrado.
- La implementación debe conservar nombres/tipos/constraints o registrar un cambio documental/ADR antes de desviarse.
- CHECKs complejos entre filas pueden requerir trigger/constraint trigger; el diccionario lo señala explícitamente.
- Estados con máquina de dominio siguen gobernados por comandos; CHECK de DB limita valores pero no sustituye guards.

# 6. Gate del diccionario

- [x]  Todas las tablas del inventario del ERD aparecen en las páginas hijas: 69/69.
- [x]  Cada tabla tiene columnas canónicas con tipo y nulabilidad/default suficientes para generar schema/migración.
- [x]  FKs tenant-owned críticas y relaciones compuestas están definidas; relaciones cross-order/version antes ambiguas quedaron cerradas.
- [x]  Estados cerrados tienen valores baseline o referencia explícita a máquina canónica.
- [x]  Dinero/cantidad/tasas tienen precisión/rango canónicos (`bigint`, `numeric(14,4)`, `numeric(7,4)`).
- [x]  Históricos/evidencias identifican mutabilidad append-only/frozen.
- [x]  Aliases narrativos (`timestamps`, `created_by`, `status`) ya no son contrato: las páginas hijas definen nombres/tipos concretos.
- [x]  ERD conceptual fue ampliado para media, privacidad, plataforma y scopes introducidos por el diccionario.

[Diccionario 01 — Tenancy, Identidad, CRM, Agenda y Recepción](Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL/Diccionario%2001%20%E2%80%94%20Tenancy,%20Identidad,%20CRM,%20Agenda%20y%203e06ab0a330d81fb94c1c237556999a0.md)

[Diccionario 02 — Órdenes, Diagnóstico, Cotizaciones y Operación](Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL/Diccionario%2002%20%E2%80%94%20%C3%93rdenes,%20Diagn%C3%B3stico,%20Cotizacione%203e06ab0a330d8179b886c1bbfd0e70f2.md)

[Diccionario 03 — Media, Comunicaciones, Billing y Pagos](Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL/Diccionario%2003%20%E2%80%94%20Media,%20Comunicaciones,%20Billing%20y%20%203e06ab0a330d8110981af4b11ce837e0.md)

[Diccionario 04 — Privacidad y Plataforma](Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL/Diccionario%2004%20%E2%80%94%20Privacidad%20y%20Plataforma%203e06ab0a330d815d8559cd85974347bc.md)

[Diccionario 05 — Inventario y Analítica Comercial](Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL/Diccionario%2005%20%E2%80%94%20Inventario%20y%20Anal%C3%ADtica%20Comercial%203e06ab0a330d81df89c9f3be92795302.md)
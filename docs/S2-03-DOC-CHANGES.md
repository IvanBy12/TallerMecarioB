# S2-03 — registro de hardening CRM

Este registro no sustituye ADR-009, el Diccionario ni el ERD. Las decisiones D-01b de S2-02 ya están en las fuentes canónicas; el delta PostgreSQL de S2-03 está implementado.

## ADR-009 §10

- `tallermecario_worker` no tiene privilegios de tabla ni columna sobre `customers`, `vehicles` ni `vehicle_owners`. Las policies RLS existentes permanecen; sin grants no conceden acceso.
- `tallermecario_api` conserva `SELECT` e `INSERT` en las tres tablas y `UPDATE` solo por columna: `customers` (`document_type`, `document_number`, `first_name`, `last_name`, `phone`, `email`, `notes`, `updated_at`); `vehicles` (`plate`, `vin`, `vehicle_type`, `brand`, `model`, `model_year`, `color`, `engine_number`, `current_mileage_km`, `updated_at`); `vehicle_owners` (`valid_to`). Ningún runtime recibe `DELETE` o `TRUNCATE`; `PUBLIC` no recibe privilegios CRM.

## Diccionario §11 — vehicles

- `vehicles_plate_normalized_check`: `plate = btrim(plate) AND plate = upper(plate COLLATE "C")`. Decisión D-01a: sin espacios ASCII iniciales/finales ni letras ASCII minúsculas. La unicidad existente `(tenant_id, plate)` sigue vigente.
- D-01b **IMPLEMENTED** en `drizzle/0018_s2_03_crm_hardening.sql`: `vehicles_plate_format_check` exige `plate COLLATE "C" ~ '^[A-Z0-9]{1,16}$'`. Las reglas por `vehicle_type` siguen diferidas (D-01c).

## Diccionario §12 — vehicle_owners

- Frozen-on-close: una relación vigente puede pasar `valid_to` de `NULL` a timestamp. Una fila con `OLD.valid_to IS NOT NULL` es inmutable incluso ante una escritura del mismo valor o reapertura. Los demás campos no cambian en ningún UPDATE. `vehicle_owners_validity_check` sigue comprobando `valid_to > valid_from`.

## ERD §5 y §18

- `app.enforce_vehicle_owner_history()` y `vehicle_owners_history_guard_trg` (`BEFORE UPDATE FOR EACH ROW`) protegen el historial para sesiones runtime y privilegiadas con triggers activos. La función es `SECURITY INVOKER`, owner `tallermecario_schema_owner`, `search_path=pg_catalog`, sin `EXECUTE` para `PUBLIC`.
- La migración 0018 no reescribe filas. El preflight corre bajo lock exclusivo y con NO FORCE temporal. Rechaza placas legacy que incumplen cualquiera de los dos CHECKs e incluye además la agrupación por tenant sobre la forma compacta `upper(regexp_replace(btrim(plate), '[ .-]', '', 'g') COLLATE "C")`, que exige el contrato S2-02. El patrón elimina solo espacio ASCII, `-` y `.`; no elimina tabulaciones ni espacios Unicode. Falla con `23514 vehicles_plate_normalized_check`, sin datos de placa/VIN/IDs en el error. El runner revierte íntegramente la transacción si falla.
- Alcance de la agrupación compacta (review final S2-03, F-1): una placa que cumple `^[A-Z0-9]{1,16}$` ya es su propia forma compacta y `UNIQUE(tenant_id, plate)` impide duplicarla, así que una colisión compacta dentro de un tenant siempre implica una fila de formato inválido. Esa rama no es alcanzable de forma independiente. Los casos de upgrade U5 (`ABC123` + `ABC-123`) y U6 (`ABC123` + `ABC 123`) son filas legacy de formato inválido cuya forma compacta colisionaría con una placa válida existente; la migración falla closed antes de modificar datos. No prueban una rama independiente de "canonical collision". El agrupamiento por tenant sí es observable: U1 (`ABC123` en dos tenants) pasa, así que no hay unicidad global. Fail-closed es correcto y no hay problema de integridad.

## Seguimiento de Quality Gate Sprint 2 (review final S2-03, F-2)

- Añadir `'A'` (una sola letra, límite inferior válido de `^[A-Z0-9]{1,16}$`) como caso válido explícito en las pruebas CRM de placa antes de S2-08 / cierre final del Sprint 2.
- PostgreSQL ya acepta `'A'` (verificado en PostgreSQL 18.4 durante el review); es solo cobertura explícita del límite inferior, no deuda funcional.
- No bloquea S2-04.
